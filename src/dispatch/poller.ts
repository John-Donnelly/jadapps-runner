import { request as undiciRequest } from "undici";
import { writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../log.js";
import type { TokenManager } from "../auth/tokens.js";
import type { Executor } from "../runtime/executor.js";
import type { ScratchManager } from "../runtime/scratch.js";
import type { ApiClient } from "../api/client.js";
import type {
  FileRef,
  RunToken,
  StepDescriptor,
  StepResult,
} from "../types.js";
import type { WebhookDispatcher } from "../webhooks/dispatcher.js";
import type { WebhookPayload } from "../webhooks/types.js";

interface ClaimResponse {
  claimed: boolean;
  reason?: string;
  queueId?: string;
  workflowId?: string;
  source?: "webhook" | "cron" | "manual";
  payload?: unknown;
  runId?: string;
  runToken?: RunToken;
  graph?: {
    nodes: Array<{ id: string; toolSlug: string; config?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string; sourcePort?: string; targetPort?: string }>;
  };
  stepNodeIds?: string[];
  /**
   * If non-null, the runner should execute steps 0..pauseAtStep-1 from
   * runToken.tools and then POST /pause with the last step's output as
   * an inline artifact instead of /finalize. The browser orchestrator
   * resumes from pauseAtStep onward.
   */
  pauseAtStep?: number | null;
  pauseReason?: string | null;
}

const PAUSE_ARTIFACT_BYTE_CAP = 1 * 1024 * 1024;

const POLL_BACKOFF_MS_NO_WORK = 10_000;
const POLL_BACKOFF_MS_AFTER_WORK = 500;
const POLL_BACKOFF_MS_ERROR = 30_000;

/**
 * Auto-dispatch poller. When enabled, polls /api/runner/dispatch/claim,
 * receives claimed runs, and executes them inline. v0.1 supports only
 * linear chains (no logic nodes); the server already rejects others.
 */
export class DispatchPoller {
  private stopRequested = false;
  private running: Promise<void> | null = null;
  private kickResolve: (() => void) | null = null;

  constructor(
    private readonly apiBase: string,
    private readonly tokens: TokenManager,
    private readonly executor: Executor,
    private readonly scratch: ScratchManager,
    private readonly api: ApiClient,
    private readonly log: Logger,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  /** External signal (e.g. from WakeSocket) that there's likely work now. */
  kick(): void {
    if (this.kickResolve) {
      this.kickResolve();
      this.kickResolve = null;
    }
  }

  start(): void {
    if (this.running) return;
    this.stopRequested = false;
    this.running = this.loop().catch((err) => {
      this.log.error({ err }, "auto-dispatch loop crashed");
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.running?.catch(() => undefined);
    this.running = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const claim = await this.claim();
        if (!claim.claimed) {
          await this.sleepInterruptible(POLL_BACKOFF_MS_NO_WORK);
          continue;
        }
        await this.executeClaim(claim);
        await sleep(POLL_BACKOFF_MS_AFTER_WORK);
      } catch (err) {
        this.log.warn({ err }, "auto-dispatch tick failed");
        await this.sleepInterruptible(POLL_BACKOFF_MS_ERROR);
      }
    }
  }

  /** Sleep that resolves early if `kick()` is called. */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.kickResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async claim(): Promise<ClaimResponse> {
    const access = await this.tokens.getAccessToken();
    const res = await undiciRequest(`${this.apiBase}/api/runner/dispatch/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access.jwt}`,
      },
      body: "{}",
    });
    if (res.statusCode === 401) {
      this.tokens.invalidate();
      throw new Error("dispatch claim returned 401");
    }
    const text = await res.body.text();
    if (res.statusCode >= 300) throw new Error(`claim ${res.statusCode}: ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as ClaimResponse) : { claimed: false };
  }

  private async executeClaim(claim: ClaimResponse): Promise<void> {
    if (!claim.runToken || !claim.graph || !claim.runId) return;
    const runToken = claim.runToken;
    const runId = claim.runId;
    const log = this.log.child({ runId, source: claim.source });
    log.info({ workflowId: claim.workflowId }, "dispatching claimed run");

    // Stage the trigger payload (if any) as the initial input file.
    let pendingFileRef: FileRef | null = null;
    const scratchDir = this.scratch.acquire(runId);
    if (claim.payload != null) {
      const text =
        typeof claim.payload === "string" ? claim.payload : JSON.stringify(claim.payload, null, 2);
      const ref = `payload-${randomUUID()}.json`;
      const path = join(scratchDir, ref);
      const buf = Buffer.from(text, "utf8");
      await writeFile(path, buf);
      pendingFileRef = {
        ref,
        bytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        mime: typeof claim.payload === "string" ? "text/plain" : "application/json",
        filename: "payload.json",
      };
    }

    const stepResults: StepResult[] = [];
    let totalBytes = 0;
    const startedAt = Date.now();
    let stepCursor = 0;

    // Walk the runToken.tools[] in order. Map each tool back to its node by
    // index so we can read the node's config for inputs.
    for (const tool of runToken.tools) {
      const node = claim.graph.nodes[tool.stepIndex];
      const step: StepDescriptor = {
        runId,
        stepIndex: stepCursor++,
        toolId: tool.toolId,
        inputs: (node?.config as Record<string, unknown>) ?? {},
        fileRefs: pendingFileRef ? [pendingFileRef] : [],
        credentialRefs:
          typeof node?.config?.credentialRef === "string"
            ? [String(node.config.credentialRef)]
            : [],
      };

      let result: StepResult;
      try {
        result = await this.executor.execute({ runToken, step });
      } catch (err) {
        log.error({ err, step: step.toolId }, "step threw");
        stepResults.push({
          ok: false,
          outputs: {},
          fileRefs: [],
          bytesProcessed: 0,
          durationMs: 0,
          error: { code: "executor_threw", message: (err as Error).message },
        });
        break;
      }

      stepResults.push(result);
      totalBytes += result.bytesProcessed;
      if (!result.ok) {
        log.warn({ tool: step.toolId, err: result.error }, "step failed");
        break;
      }
      // Thread the first output file as the next step's input. Steps that emit
      // no file (e.g. slack-postmessage) drop the cursor → next step gets
      // whatever the last text output was (synthesised here for completeness).
      if (result.fileRefs.length > 0) {
        pendingFileRef = result.fileRefs[0]!;
      } else if (result.outputs && Object.keys(result.outputs).length > 0) {
        const text = JSON.stringify(result.outputs, null, 2);
        const ref = `step${tool.stepIndex}-out-${randomUUID()}.json`;
        const path = join(scratchDir, ref);
        const buf = Buffer.from(text, "utf8");
        await writeFile(path, buf);
        pendingFileRef = {
          ref,
          bytes: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
          mime: "application/json",
          filename: `step${tool.stepIndex}.json`,
        };
      }
    }

    // Hybrid pause path: hand off to the browser if pauseAtStep was set
    // and we ran our prefix successfully (no errors).
    const allOk = stepResults.every((r) => r.ok);
    if (
      claim.pauseAtStep != null &&
      allOk &&
      stepResults.length > 0
    ) {
      const artifact = await buildPauseArtifact(pendingFileRef, scratchDir, log);
      try {
        await this.api.pauseRun(runId, runToken.jwt, {
          pausedAtStep: claim.pauseAtStep,
          durationMs: Date.now() - startedAt,
          bytesProcessed: totalBytes,
          artifact,
        });
        log.info(
          { pauseAtStep: claim.pauseAtStep, hasArtifact: !!artifact, reason: claim.pauseReason },
          "run paused for browser handoff",
        );
      } catch (err) {
        log.warn({ err }, "pause failed");
      } finally {
        this.scratch.release(runId);
      }
      return;
    }

    try {
      await this.api.finalizeRun(runId, runToken.jwt, {
        steps: stepResults,
        durationMs: Date.now() - startedAt,
        bytesProcessed: totalBytes,
      });
    } catch (err) {
      log.warn({ err }, "finalize failed");
    } finally {
      this.scratch.release(runId);
    }

    this.fireWebhook({
      ok: allOk,
      runId,
      workflowId: claim.workflowId,
      startedAt,
      stepResults,
      totalBytes,
    });

    log.info({ ok: allOk, steps: stepResults.length }, "run complete");
  }

  private fireWebhook(args: {
    ok: boolean;
    runId: string;
    workflowId: string | undefined;
    startedAt: number;
    stepResults: StepResult[];
    totalBytes: number;
  }): void {
    const finishedAt = Date.now();
    const failed = args.stepResults.find((s) => !s.ok);
    const payload: WebhookPayload = {
      event: args.ok ? "workflow.completed" : "workflow.failed",
      delivered_at: new Date(finishedAt).toISOString(),
      workflow: {
        id: args.workflowId ?? "",
        // Server-claimed runs don't include the workflow name in the claim
        // response — surface the id so recipients have a stable handle.
        name: args.workflowId ?? "",
        version: null,
      },
      run: {
        id: args.runId,
        status: args.ok ? "succeeded" : "failed",
        started_at: new Date(args.startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - args.startedAt,
        bytes_processed: args.totalBytes,
        step_count: args.stepResults.length,
        error: failed?.error?.message ?? null,
      },
    };
    try {
      this.webhooks.fireForEvent(payload.event, payload);
    } catch (err) {
      this.log.warn({ err, runId: args.runId }, "webhook fireForEvent threw");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read the last step's output from scratch into an inline base64 artifact.
 * Caps at 1MB; larger artifacts return null and the browser starts the
 * resume from a fresh input (v0.2 will move them to Supabase Storage).
 */
async function buildPauseArtifact(
  ref: { ref: string; bytes: number; sha256: string; mime: string; filename: string } | null,
  scratchDir: string,
  log: Logger,
): Promise<{ base64: string; mime: string; filename: string } | null> {
  if (!ref) return null;
  if (ref.bytes > PAUSE_ARTIFACT_BYTE_CAP) {
    log.warn(
      { bytes: ref.bytes, cap: PAUSE_ARTIFACT_BYTE_CAP },
      "pause artifact exceeds inline cap; browser will resume without it",
    );
    return null;
  }
  try {
    const buf = await readFile(join(scratchDir, ref.ref));
    return {
      base64: buf.toString("base64"),
      mime: ref.mime,
      filename: ref.filename,
    };
  } catch (err) {
    log.warn({ err }, "failed to read pause artifact from scratch");
    return null;
  }
}
