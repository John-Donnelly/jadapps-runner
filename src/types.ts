export type Tier = "free" | "pro" | "pro_media" | "developer" | "enterprise";

export type Runtime =
  | "browser"
  | "runner-local"
  | "runner-native"
  | "runner-builtin"
  | "runner-via-server";

export interface RunToken {
  runId: string;
  jwt: string;
  byteBudget: number;
  expiresAt: number;
  allowedRuntimes: Runtime[];
  tools: ToolBundleRef[];
}

export interface ToolBundleRef {
  stepIndex: number;
  toolId: string;
  bundleUrl: string;
  bundleSha256: string;
  decryptionKey: string | null;
  runtime: Runtime;
  ttlSec: number;
}

export interface StepDescriptor {
  runId: string;
  stepIndex: number;
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentialRefs: string[];
}

export interface FileRef {
  ref: string;
  bytes: number;
  sha256: string;
  mime: string;
  filename: string;
}

export interface StepResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  fileRefs: FileRef[];
  bytesProcessed: number;
  durationMs: number;
  error?: { code: string; message: string };
}

export interface DeviceIdentity {
  deviceId: string;
  pubKey: string;
  privKey: string;
  pairedAt: number;
  userId: string;
  apiBase: string;
}

export interface AccessToken {
  jwt: string;
  expiresAt: number;
  tier: Tier;
  limits: {
    maxBytesPerRun: number;
    maxConcurrentRuns: number;
    monthlyByteBudget: number;
  };
}

export interface TelemetryEvent {
  runId: string;
  eventSeq: number;
  type: "step_start" | "step_progress" | "step_complete" | "step_error" | "run_complete";
  stepIndex?: number;
  bytesProcessed?: number;
  ms?: number;
  runtime?: Runtime;
  error?: string;
  ts: number;
}

export interface Credential {
  ref: string;
  type: "api_key" | "oauth2" | "basic" | "custom";
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
