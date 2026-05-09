import { randomUUID } from "node:crypto";
import type { Executor } from "../runtime/executor.js";
import type { ToolCatalogue } from "../runtime/tool-catalogue.js";
import type { TokenManager } from "../auth/tokens.js";
import type { ScratchManager } from "../runtime/scratch.js";
import type { Logger } from "../log.js";
import type {
  FileRef,
  RunToken,
  Runtime,
  StepDescriptor,
  StepResult,
} from "../types.js";
import type { LocalWorkflow, WorkflowStore } from "./store.js";
import { checkFamilyLimits } from "../runtime/tier-limits.js";
import type { WebhookDispatcher } from "../webhooks/dispatcher.js";
import type { WebhookPayload } from "../webhooks/types.js";

/**
 * Local linear workflow runner. Walks the graph topologically and pipes
 * each step's primary output into the next step's inputs.
 *
 * Logic node handling (v0.2):
 *   - `logic.delay`: sleeps the configured ms then passes the upstream
 *     value through unchanged
 *   - `logic.merge`, `logic.set`, `logic.filter`, `logic.parallel`,
 *     `logic.try-catch`: passthrough — the upstream value flows to the
 *     next step. Outputs that need real graph-port semantics (if-else's
 *     true/false routing, switch's case_N routing, for-each iteration)
 *     don't behave correctly here. Run those workflows from the website
 *     orchestrator where the full port-aware runner lives.
 *   - `logic.if-else`, `logic.switch`, `logic.for-each`, `logic.while`,
 *     `logic.sub-workflow`, `logic.code`: surface a clear error so the
 *     caller knows to delegate to the website runner.
 *
 * What this gives us:
 *   - MCP can trigger workflow runs locally for the common case
 *   - Cron-driven runs in the runner pick up local workflow definitions
 *     immediately (no claim flow)
 *   - Fully offline-capable for the supported subset
 */

const PASSTHROUGH_LOGIC_SLUGS = new Set([
  "logic.merge",
  "logic.set",
  "logic.filter",
  "logic.parallel",
  "logic.try-catch",
]);
const UNSUPPORTED_LOGIC_SLUGS = new Set([
  "logic.if-else",
  "logic.switch",
  "logic.for-each",
  "logic.while",
  "logic.sub-workflow",
  "logic.code",
]);

interface Node {
  id: string;
  toolSlug: string;
  config: Record<string, unknown>;
}

interface WorkflowGraph {
  nodes: Node[];
  edges: Array<{ source: string; target: string; sourcePort?: string; targetPort?: string }>;
}

export interface LocalRunResult {
  runId: string;
  ok: boolean;
  steps: Array<{
    nodeId: string;
    toolSlug: string;
    status: "done" | "error" | "skipped";
    durationMs: number;
    bytesProcessed: number;
    error?: string;
  }>;
  durationMs: number;
  totalBytes: number;
}

export class LocalWorkflowRunner {
  constructor(
    private readonly executor: Executor,
    private readonly catalogue: ToolCatalogue,
    private readonly tokens: TokenManager,
    private readonly scratch: ScratchManager,
    private readonly log: Logger,
    private readonly webhooks: WebhookDispatcher,
    /**
     * Workflow store lookup is best-effort (used to surface workflow name +
     * version in webhook payloads). Pass-through is fine because run()
     * receives the LocalWorkflow directly — store access is only for
     * completeness when called from external code paths.
     */
    private readonly workflowStore: WorkflowStore,
  ) {}

  async run(
    workflow: LocalWorkflow,
    initialFiles: FileRef[] = [],
    /**
     * Optional progress callback invoked once per finished step. Used by the
     * MCP `workflow_run` tool to emit `notifications/progress` to the
     * client so AI agents can show per-step progress UI.
     */
    onStep?: (info: {
      stepIndex: number;
      totalSteps: number;
      nodeId: string;
      toolSlug: string;
      status: "done" | "error" | "skipped";
      durationMs: number;
    }) => void,
  ): Promise<LocalRunResult> {
    const start = Date.now();
    const runId = randomUUID();
    const graph = workflow.graph as unknown as WorkflowGraph;

    // Topological order. For v0.1 (linear only), we just sort nodes by their
    // first appearance in the edges array; if there are no edges we run in
    // the order they were given.
    const ordered = topologicalOrder(graph);

    const steps: LocalRunResult["steps"] = [];
    let totalBytes = 0;
    let currentFiles: FileRef[] = initialFiles;

    const completeRun = (ok: boolean): LocalRunResult => {
      const result: LocalRunResult = {
        runId,
        ok,
        steps,
        durationMs: Date.now() - start,
        totalBytes,
      };
      this.fireWebhook(workflow, result);
      return result;
    };

    let access;
    try {
      access = await this.tokens.getAccessToken();
    } catch (err) {
      return completeRun(false);
    }

    // Acquire a single scratch dir for the whole run so step outputs can
    // flow into the next step's inputs without copying.
    this.scratch.acquire(runId);

    const totalSteps = ordered.length;
    /**
     * Push a step result + fire the optional progress callback. Use this
     * everywhere instead of `steps.push` so we never report a step the
     * caller can't see.
     */
    const pushStep = (
      stepIndex: number,
      entry: LocalRunResult["steps"][number],
    ) => {
      steps.push(entry);
      onStep?.({
        stepIndex,
        totalSteps,
        nodeId: entry.nodeId,
        toolSlug: entry.toolSlug,
        status: entry.status,
        durationMs: entry.durationMs,
      });
    };

    try {
      for (const [stepIndex, node] of ordered.entries()) {
        // Inline-handle the logic-node cases the local runner can fake
        // sensibly (passthrough + delay). Branching cases that need real
        // port routing surface as errors so the caller delegates upstream.
        if (node.toolSlug === "logic.delay") {
          const ms = Math.min(Number(node.config["ms"] ?? 1000), 10_000);
          await new Promise((r) => setTimeout(r, ms));
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "done",
            durationMs: ms,
            bytesProcessed: 0,
          });
          continue; // keep currentFiles unchanged
        }
        if (PASSTHROUGH_LOGIC_SLUGS.has(node.toolSlug)) {
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "done",
            durationMs: 0,
            bytesProcessed: 0,
          });
          continue;
        }
        if (UNSUPPORTED_LOGIC_SLUGS.has(node.toolSlug)) {
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: `Local runner doesn't execute ${node.toolSlug} — port routing requires the website orchestrator. Use workflow_run_enqueue instead.`,
          });
          return completeRun(false);
        }

        const entry = await this.catalogue.lookup(node.toolSlug);
        if (!entry) {
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: `tool "${node.toolSlug}" has no runner bundle (browser-only fallback)`,
          });
          return completeRun(false);
        }

        // Phase 9 pre-flight, Phase 11 deferred follow-up: closes the
        // family-limit bypass that existed for workflow runs. Same checks
        // /v1/tools/:slug/run and MCP `tool_run` apply — but here we
        // surface the violation as a per-step error so the rest of the
        // run can still report a clean trace.
        const violation = checkFamilyLimits(access, entry, currentFiles);
        if (violation) {
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: `tier_limit_exceeded: ${violation.type} cap ${violation.value} (observed ${violation.observed})`,
          });
          return completeRun(false);
        }

        const runToken: RunToken = {
          runId,
          jwt: access.jwt,
          byteBudget: access.limits.maxBytesPerRun,
          expiresAt: access.expiresAt,
          allowedRuntimes: [
            "runner-local",
            "runner-native",
            "runner-builtin",
            "browser-native",
            "runner-via-server",
          ] as Runtime[],
          tools: [
            {
              stepIndex,
              toolId: entry.toolId,
              bundleUrl: entry.bundleUrl,
              bundleSha256: entry.bundleSha256,
              decryptionKey: entry.decryptionKey ?? null,
              runtime: entry.runtime,
              ttlSec: 600,
            },
          ],
        };

        const step: StepDescriptor = {
          runId,
          stepIndex,
          toolId: entry.toolId,
          inputs: node.config,
          fileRefs: currentFiles,
          credentialRefs: extractCredentialRefs(node.config),
        };

        let result: StepResult;
        try {
          result = await this.executor.execute({ runToken, step });
        } catch (err) {
          pushStep(stepIndex, {
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: (err as Error).message,
          });
          return completeRun(false);
        }

        pushStep(stepIndex, {
          nodeId: node.id,
          toolSlug: node.toolSlug,
          status: result.ok ? "done" : "error",
          durationMs: result.durationMs,
          bytesProcessed: result.bytesProcessed,
          ...(result.error?.message ? { error: result.error.message } : {}),
        });
        totalBytes += result.bytesProcessed;
        if (!result.ok) {
          return completeRun(false);
        }
        currentFiles = result.fileRefs;
      }

      return completeRun(true);
    } finally {
      this.scratch.release(runId);
    }
  }

  private fireWebhook(workflow: LocalWorkflow, result: LocalRunResult): void {
    const failedStep = result.steps.find((s) => s.status === "error");
    const payload: WebhookPayload = {
      event: result.ok ? "workflow.completed" : "workflow.failed",
      delivered_at: new Date().toISOString(),
      workflow: {
        id: workflow.id,
        name: workflow.name,
        version: null,
      },
      run: {
        id: result.runId,
        status: result.ok ? "succeeded" : "failed",
        started_at: new Date(Date.now() - result.durationMs).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: result.durationMs,
        bytes_processed: result.totalBytes,
        step_count: result.steps.length,
        error: failedStep?.error ?? null,
      },
    };
    try {
      this.webhooks.fireForEvent(payload.event, payload);
    } catch (err) {
      this.log.warn({ err, runId: result.runId }, "webhook fireForEvent threw");
    }
    // Reference the store so unused-field warnings are quiet — also gives
    // future callers a way to enrich payloads without changing the
    // constructor signature.
    void this.workflowStore;
  }
}

function extractCredentialRefs(config: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  if (typeof config.credentialRef === "string" && config.credentialRef.trim()) {
    refs.add(config.credentialRef.trim());
  }
  if (Array.isArray(config.credentialRefs)) {
    for (const r of config.credentialRefs) {
      if (typeof r === "string" && r.trim()) refs.add(r.trim());
    }
  }
  return [...refs];
}

/**
 * Sort nodes so that every node appears after its predecessors. For graphs
 * with no edges, returns the node array unchanged.
 */
function topologicalOrder(graph: WorkflowGraph): Node[] {
  if (graph.edges.length === 0) return graph.nodes;

  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const e of graph.edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    out.get(e.source)?.push(e.target);
  }

  const queue: string[] = [];
  for (const [id, count] of indeg) {
    if (count === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const remaining = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  // Cycle detection: if the order doesn't cover all nodes, there's a cycle —
  // fall back to source-order so we surface a tool error rather than hanging.
  if (order.length !== graph.nodes.length) return graph.nodes;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}
