import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface RunnerConfig {
  apiBase: string;
  host: string;
  port: number;
  dataDir: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  dev: boolean;
  /** When true, the runner polls /api/runner/dispatch/claim and runs queued workflows. */
  autoDispatch: boolean;
}

const DEFAULT_DATA_DIR = join(homedir(), ".jadapps-runner");

export function loadConfig(): RunnerConfig {
  const dataDir = process.env.JADAPPS_RUNNER_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "scratch"), { recursive: true });

  return {
    apiBase: (process.env.JADAPPS_API_BASE ?? "https://jadapps.app").replace(/\/$/, ""),
    host: process.env.JADAPPS_RUNNER_HOST ?? "127.0.0.1",
    port: Number(process.env.JADAPPS_RUNNER_PORT ?? 49217),
    dataDir,
    logLevel: (process.env.JADAPPS_RUNNER_LOG_LEVEL as RunnerConfig["logLevel"]) ?? "info",
    dev: process.env.JADAPPS_RUNNER_DEV === "true",
    autoDispatch: process.env.JADAPPS_RUNNER_AUTO_DISPATCH === "true",
  };
}

export function paths(cfg: RunnerConfig) {
  return {
    sqlite: join(cfg.dataDir, "runner.db"),
    scratch: join(cfg.dataDir, "scratch"),
    pairing: join(cfg.dataDir, "pairing.json"),
  };
}
