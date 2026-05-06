import type { Runtime, RunToken, StepDescriptor } from "../types.js";

export interface RoutingDecision {
  runtime: Runtime;
  bundleIndex: number;
  reason: string;
}

const FILE_SIZE_THRESHOLD = 10 * 1024 * 1024;

/**
 * Decides which runtime should execute this step. Source of truth is the
 * server-issued runToken (it lists the runtime per step) but we apply local
 * size-based overrides where the server allows multiple runtimes for a step.
 */
export function decideRuntime(step: StepDescriptor, runToken: RunToken): RoutingDecision {
  const ref = runToken.tools.find((t) => t.stepIndex === step.stepIndex);
  if (!ref) {
    throw new Error(`no bundle ref for step ${step.stepIndex}`);
  }

  const totalBytes = step.fileRefs.reduce((acc, f) => acc + f.bytes, 0);
  // Currently the server pre-decides; we honour it. The local override hook is
  // the right place to add "small jobs stay in browser" routing once we wire
  // the browser-side decision in too.
  return {
    runtime: ref.runtime,
    bundleIndex: runToken.tools.indexOf(ref),
    reason:
      totalBytes > FILE_SIZE_THRESHOLD
        ? `server-assigned ${ref.runtime}, large input (${totalBytes}b)`
        : `server-assigned ${ref.runtime}`,
  };
}
