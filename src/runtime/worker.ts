import { parentPort, workerData } from "node:worker_threads";
import type { Credential, FileRef, StepResult } from "../types.js";

interface WorkerInit {
  modulePath: string;
  toolId: string;
  scratchDir: string;
}

interface WorkerJob {
  jobId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
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
}

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
      scratchDir: init.scratchDir,
      emitProgress: (bytes) => port.postMessage({ type: "progress", jobId: job.jobId, bytes }),
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
