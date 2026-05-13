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
import {
  materializeContentInput,
  materializePathInput,
  normaliseInputContent,
  resolveInputPath,
  writeOutputsToDir,
} from "../mcp/input-materialize.js";

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
  /** FileRefs the last step produced — what `outputDir` was filled from. */
  finalFiles?: FileRef[];
  /**
   * Absolute disk paths the final-step outputs were written to. Present only
   * when the caller passed `outputDir` in RunOptions. Empty array when no
   * outputs were produced; absent when no outputDir was requested.
   */
  outputPaths?: string[];
}

export interface RunOptions {
  /**
   * Files already in scratch under their own refs. Used when the caller has
   * pre-materialised inputs; rare for MCP callers, who should use
   * inputContent/inputPaths instead.
   */
  initialFiles?: FileRef[];
  /**
   * Raw text content to feed the first step. Written to scratch as a file
   * inside this run's scratch dir; the first step sees a normal FileRef.
   * Accepts a single string (filename inferred from the first node's slug)
   * or `[{filename, content, mimeType?}, …]`.
   */
  inputContent?:
    | string
    | Array<{ filename: string; content: string; mimeType?: string | undefined }>;
  /**
   * Local-disk paths to feed the first step. Hard-linked into the run's
   * scratch dir. Absolute paths required, OR relative paths combined with
   * `cwd`.
   */
  inputPaths?: Array<
    string | { path: string; mimeType?: string | undefined; filename?: string | undefined }
  >;
  /** Absolute working directory to resolve relative `inputPaths` against. */
  cwd?: string;
  /**
   * Absolute directory to write the last step's output files to. The runner
   * mkdirs recursively. When set, the return carries `outputPaths`; otherwise
   * final outputs stay in scratch and are released when run() returns.
   */
  outputDir?: string;
  /** Allow clobbering existing files in outputDir. Defaults false. */
  overwrite?: boolean;
  /** Per-step progress callback. */
  onStep?: (info: {
    stepIndex: number;
    totalSteps: number;
    nodeId: string;
    toolSlug: string;
    status: "done" | "error" | "skipped";
    durationMs: number;
  }) => void;
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
    opts: RunOptions = {},
  ): Promise<LocalRunResult> {
    const start = Date.now();
    const runId = randomUUID();
    const graph = workflow.graph as unknown as WorkflowGraph;
    const initialFiles = opts.initialFiles ?? [];
    const onStep = opts.onStep;

    // Topological order. For v0.1 (linear only), we just sort nodes by their
    // first appearance in the edges array; if there are no edges we run in
    // the order they were given.
    const ordered = topologicalOrder(graph);

    const steps: LocalRunResult["steps"] = [];
    let totalBytes = 0;
    let currentFiles: FileRef[] = initialFiles;

    const completeRun = async (ok: boolean): Promise<LocalRunResult> => {
      const result: LocalRunResult = {
        runId,
        ok,
        steps,
        durationMs: Date.now() - start,
        totalBytes,
        finalFiles: currentFiles,
      };
      // If the caller asked for the outputs on disk and the run succeeded,
      // copy them out BEFORE the finally block releases the scratch dir.
      // On failure we deliberately skip — there's nothing the caller would
      // want from a half-finished pipeline at a stable named location.
      if (ok && opts.outputDir && currentFiles.length > 0) {
        const written = await writeOutputsToDir({
          outputDir: opts.outputDir,
          overwrite: !!opts.overwrite,
          runId,
          outputRefs: currentFiles,
          scratch: this.scratch,
        });
        if ("error" in written) {
          // Surface as a final-step error so the run is reported as failed.
          steps.push({
            nodeId: "__outputDir__",
            toolSlug: "outputDir.write",
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: written.error,
          });
          result.ok = false;
        } else {
          result.outputPaths = written.paths;
        }
      } else if (opts.outputDir) {
        result.outputPaths = [];
      }
      this.fireWebhook(workflow, result);
      return result;
    };

    let access;
    try {
      access = await this.tokens.getAccessToken();
    } catch (err) {
      return await completeRun(false);
    }

    // Acquire a single scratch dir for the whole run so step outputs can
    // flow into the next step's inputs without copying.
    const scratchDir = this.scratch.acquire(runId);

    // Materialise inputContent + inputPaths into scratch BEFORE the first
    // step runs so they appear as normal FileRefs to the executor. Order:
    // inputContent first, then inputPaths, then any pre-materialised
    // initialFiles. Errors surface as a failed-before-first-step result.
    try {
      const firstSlug = ordered[0]?.toolSlug ?? "workflow";
      for (const entry of normaliseInputContent(opts.inputContent, firstSlug)) {
        const ref = await materializeContentInput(entry, scratchDir);
        currentFiles = [...currentFiles, ref];
      }
      for (const raw of opts.inputPaths ?? []) {
        const spec =
          typeof raw === "string"
            ? { path: raw, mimeType: undefined, filename: undefined }
            : raw;
        const resolved = resolveInputPath(spec.path, opts.cwd);
        if ("error" in resolved) {
          steps.push({
            nodeId: "__input__",
            toolSlug: "workflow.input",
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: resolved.error,
          });
          return await completeRun(false);
        }
        const materialised = await materializePathInput(
          { ...spec, path: resolved.path },
          scratchDir,
        );
        if ("error" in materialised) {
          steps.push({
            nodeId: "__input__",
            toolSlug: "workflow.input",
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: materialised.error,
          });
          return await completeRun(false);
        }
        currentFiles = [...currentFiles, materialised.ref];
      }
    } catch (err) {
      steps.push({
        nodeId: "__input__",
        toolSlug: "workflow.input",
        status: "error",
        durationMs: 0,
        bytesProcessed: 0,
        error: (err as Error).message,
      });
      return await completeRun(false);
    }

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
          return await completeRun(false);
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
          return await completeRun(false);
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
          return await completeRun(false);
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
          return await completeRun(false);
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
          return await completeRun(false);
        }
        currentFiles = result.fileRefs;
      }

      return await completeRun(true);
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
