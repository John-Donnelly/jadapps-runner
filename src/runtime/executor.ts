import type { Logger } from "../log.js";
import type { ApiClient } from "../api/client.js";
import type { CredentialStore } from "../credentials/store.js";
import type { TelemetryClient } from "../telemetry/client.js";
import type { TokenManager } from "../auth/tokens.js";
import type { Credential, RunToken, StepDescriptor, StepResult } from "../types.js";
import type { BundleLoader } from "./bundle-loader.js";
import type { WorkerPool } from "./worker-pool.js";
import type { ScratchManager } from "./scratch.js";
import { decideRuntime } from "./router.js";

interface ExecuteInput {
  runToken: RunToken;
  step: StepDescriptor;
}

/**
 * The execution orchestrator. Owns the per-step lifecycle:
 *   1. resolve runtime (router)
 *   2. for runner-via-server: forward to API and stream result
 *   3. for runner-local / runner-native: load bundle, dispatch worker, capture progress
 *   4. collect credentials by ref (scoped to those listed on the step)
 *   5. emit telemetry start/progress/complete/error
 */
export class Executor {
  private eventSeq = new Map<string, number>();

  constructor(
    private readonly log: Logger,
    private readonly api: ApiClient,
    private readonly tokens: TokenManager,
    private readonly credentials: CredentialStore,
    private readonly telemetry: TelemetryClient,
    private readonly bundles: BundleLoader,
    private readonly workers: WorkerPool,
    private readonly scratch: ScratchManager,
  ) {}

  async execute({ runToken, step }: ExecuteInput): Promise<StepResult> {
    const decision = decideRuntime(step, runToken);
    const start = Date.now();
    this.emit(runToken, step.runId, "step_start", step.stepIndex, 0, decision.runtime);

    try {
      let result: StepResult;
      if (decision.runtime === "runner-via-server") {
        result = await this.api.executeServerSide(step, runToken.jwt);
      } else {
        const bundleRef = runToken.tools[decision.bundleIndex];
        if (!bundleRef) throw new Error(`no bundle for step ${step.stepIndex}`);
        const access = await this.tokens.getAccessToken();
        const loaded = await this.bundles.load(bundleRef, access.jwt);
        const creds: Record<string, Credential> = {};
        for (const ref of step.credentialRefs) {
          const c = this.credentials.get(ref);
          if (!c) throw new Error(`credential not found: ${ref}`);
          creds[ref] = c;
        }
        const scratchDir = this.scratch.acquire(step.runId);
        result = await this.workers.exec(
          { modulePath: loaded.modulePath, toolId: loaded.toolId, scratchDir },
          step.inputs,
          step.fileRefs,
          creds,
          (bytes) =>
            this.emit(runToken, step.runId, "step_progress", step.stepIndex, bytes, decision.runtime),
        );
      }

      this.emit(
        runToken,
        step.runId,
        result.ok ? "step_complete" : "step_error",
        step.stepIndex,
        result.bytesProcessed,
        decision.runtime,
        result.error?.message,
      );
      return result;
    } catch (err) {
      const message = (err as Error).message;
      this.emit(
        runToken,
        step.runId,
        "step_error",
        step.stepIndex,
        0,
        decision.runtime,
        message,
      );
      return {
        ok: false,
        outputs: {},
        fileRefs: [],
        bytesProcessed: 0,
        durationMs: Date.now() - start,
        error: { code: "executor_threw", message },
      };
    }
  }

  private emit(
    runToken: RunToken,
    runId: string,
    type:
      | "step_start"
      | "step_progress"
      | "step_complete"
      | "step_error"
      | "run_complete",
    stepIndex: number,
    bytes: number,
    runtime: ReturnType<typeof decideRuntime>["runtime"],
    error?: string,
  ) {
    const next = (this.eventSeq.get(runId) ?? 0) + 1;
    this.eventSeq.set(runId, next);
    this.telemetry.emit(
      {
        runId,
        eventSeq: next,
        type,
        stepIndex,
        bytesProcessed: bytes,
        runtime,
        ...(error ? { error } : {}),
        ts: Date.now(),
      },
      runToken.jwt,
    );
  }
}
