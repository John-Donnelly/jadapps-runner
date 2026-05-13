import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import type { Credential, FileRef, StepResult } from "../types.js";

interface WorkerInit {
  modulePath: string;
  toolId: string;
}

interface WorkerJob {
  jobId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
  scratchDir: string;
}

interface ToolModule {
  default: ToolImpl;
}

type ToolImpl = (ctx: ToolContext) => Promise<StepResult>;

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
  scratchDir: string;
  emitProgress(bytes: number): void;
  /**
   * Loads a vetted runtime module from the runner's node_modules so heavy
   * libraries don't have to be inlined into every encrypted bundle. The
   * allowlist below keeps bundles from reaching into arbitrary internals.
   */
  requireRuntime(name: string): unknown;
}

/**
 * Allowlist of npm packages bundles can pull from the runner's runtime.
 * Adding an entry here exposes the real module to bundle code; it
 * survives encryption, version drift, and the IP-protection envelope.
 */
const RUNTIME_MODULE_ALLOWLIST = new Set([
  "js-yaml",
  "fast-xml-parser",
  "playwright",
  "sharp",
]);
const runtimeRequire = createRequire(import.meta.url);

const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error("worker started without parent port");

let toolPromise: Promise<ToolModule> | null = null;

function loadTool(): Promise<ToolModule> {
  if (toolPromise) return toolPromise;
  // file:// URL is required for ESM dynamic import on Windows.
  const url = new URL(`file:///${init.modulePath.replace(/\\/g, "/")}`);
  toolPromise = import(url.href) as Promise<ToolModule>;
  return toolPromise;
}

port.on("message", async (job: WorkerJob) => {
  const start = Date.now();
  try {
    const mod = await loadTool();
    if (typeof mod.default !== "function") {
      throw new Error(`tool ${init.toolId} has no default export`);
    }
    const ctx: ToolContext = {
      toolId: init.toolId,
      inputs: job.inputs,
      fileRefs: job.fileRefs,
      credentials: job.credentials,
      scratchDir: job.scratchDir,
      emitProgress: (bytes) => port.postMessage({ type: "progress", jobId: job.jobId, bytes }),
      requireRuntime: (name: string) => {
        if (!RUNTIME_MODULE_ALLOWLIST.has(name)) {
          throw new Error(
            `requireRuntime('${name}'): module is not in the runner allowlist. ` +
              `Add it to RUNTIME_MODULE_ALLOWLIST in src/runtime/worker.ts.`,
          );
        }
        return runtimeRequire(name);
      },
    };
    const result = await mod.default(ctx);
    port.postMessage({
      type: "result",
      jobId: job.jobId,
      result: { ...result, durationMs: Date.now() - start },
    });
  } catch (err) {
    const e = err as Error;
    port.postMessage({
      type: "result",
      jobId: job.jobId,
      result: {
        ok: false,
        outputs: {},
        fileRefs: [],
        bytesProcessed: 0,
        durationMs: Date.now() - start,
        error: { code: "tool_threw", message: e.message },
      } satisfies StepResult,
    });
  }
});
