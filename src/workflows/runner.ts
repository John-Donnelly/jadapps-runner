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
import type { LocalWorkflow } from "./store.js";

/**
 * Local linear workflow runner. v0.1 supports flat workflows where each
 * step's primary output feeds directly into the next step (no branching).
 * Logic nodes (logic.if-else, logic.for-each, logic.switch, etc.) are
 * surfaced as errors — the website's browser-side runner is the canonical
 * branching executor for now.
 *
 * What this gives us:
 *   - MCP can trigger workflow runs locally without round-tripping the
 *     website
 *   - Cron-driven runs in the runner pick up local workflow definitions
 *     immediately (no claim flow)
 *   - Fully offline-capable for the linear-only subset
 */

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
  ) {}

  async run(
    workflow: LocalWorkflow,
    initialFiles: FileRef[] = [],
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
    let access;
    try {
      access = await this.tokens.getAccessToken();
    } catch (err) {
      return {
        runId,
        ok: false,
        steps: [],
        durationMs: Date.now() - start,
        totalBytes: 0,
      };
    }

    // Acquire a single scratch dir for the whole run so step outputs can
    // flow into the next step's inputs without copying.
    this.scratch.acquire(runId);

    try {
      for (const [stepIndex, node] of ordered.entries()) {
        if (node.toolSlug.startsWith("logic.")) {
          steps.push({
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error:
              "Local linear runner doesn't support logic nodes yet — run this workflow from the website orchestrator instead.",
          });
          return {
            runId,
            ok: false,
            steps,
            durationMs: Date.now() - start,
            totalBytes,
          };
        }

        const entry = await this.catalogue.lookup(node.toolSlug);
        if (!entry) {
          steps.push({
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: `tool "${node.toolSlug}" has no runner bundle (browser-only fallback)`,
          });
          return {
            runId,
            ok: false,
            steps,
            durationMs: Date.now() - start,
            totalBytes,
          };
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
              decryptionKey: null,
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
          steps.push({
            nodeId: node.id,
            toolSlug: node.toolSlug,
            status: "error",
            durationMs: 0,
            bytesProcessed: 0,
            error: (err as Error).message,
          });
          return {
            runId,
            ok: false,
            steps,
            durationMs: Date.now() - start,
            totalBytes,
          };
        }

        steps.push({
          nodeId: node.id,
          toolSlug: node.toolSlug,
          status: result.ok ? "done" : "error",
          durationMs: result.durationMs,
          bytesProcessed: result.bytesProcessed,
          ...(result.error?.message ? { error: result.error.message } : {}),
        });
        totalBytes += result.bytesProcessed;
        if (!result.ok) {
          return {
            runId,
            ok: false,
            steps,
            durationMs: Date.now() - start,
            totalBytes,
          };
        }
        currentFiles = result.fileRefs;
      }

      return {
        runId,
        ok: true,
        steps,
        durationMs: Date.now() - start,
        totalBytes,
      };
    } finally {
      this.scratch.release(runId);
    }
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
