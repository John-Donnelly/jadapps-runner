#!/usr/bin/env node
/**
 * Stage everything the runner needs to ship a self-contained Node sidecar
 * into a single directory. Shared between the Tauri shell (Mac/Linux) and
 * the WinUI3 shell (Windows) so both consume the same canonical bundle.
 *
 *   <dest>/
 *     cli.js                  ← tsup output
 *     runner.js               ← tsup output
 *     builtin-connectors/     ← all connector .js files
 *     runtime/                ← worker.js
 *     package.json            ← copy of root package.json
 *     package-lock.json       ← copy of root package-lock
 *     node_modules/           ← npm ci --omit=dev result
 *
 * This is large (~300 MB) but gets compressed at install time. The
 * shell-specific stagers (stage-tauri-bundle, stage-winui-bundle)
 * call this and then add their own host-bundler-specific extras
 * (e.g. Tauri's externalBin Node binary).
 */

import { execSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

/**
 * Stage the runtime bundle at the given destination. Mutates `dest`:
 * removes any prior contents and replaces them with a fresh copy of
 * `dist/`, the root `package.json`/`package-lock.json`, and a fresh
 * `node_modules/` from `npm ci --omit=dev`.
 *
 * @param {string} dest absolute path to the destination directory
 */
export function stageRuntimeBundle(dest) {
  if (!existsSync(dist) || !existsSync(join(dist, "cli.js"))) {
    throw new Error("dist/cli.js not found — run `npm run build` first.");
  }

  console.log(`Staging runtime bundle at ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  console.log("  copying dist/ → runtime-bundle/");
  cpSync(dist, dest, { recursive: true });

  console.log("  copying package.json + package-lock.json");
  copyFileSync(join(root, "package.json"), join(dest, "package.json"));
  copyFileSync(
    join(root, "package-lock.json"),
    join(dest, "package-lock.json"),
  );

  // `npm ci --omit=dev` is deterministic, runs install scripts so
  // native deps (better-sqlite3 prebuilds, sharp libvips,
  // @napi-rs/canvas) get their .node files downloaded, and
  // guarantees the tree matches the lockfile.
  console.log("  installing production node_modules (this takes a minute)…");
  execSync("npm ci --omit=dev --no-audit --no-fund", {
    cwd: dest,
    stdio: "inherit",
  });
}

/**
 * Copy the Node binary that's currently running this script into the
 * given destination. Used by host bundlers (Tauri's externalBin,
 * WinUI3's MSIX assets) that need an ABI-matched Node alongside the
 * node_modules tree — the prebuilt .node files were compiled for
 * THIS Node's NODE_MODULE_VERSION.
 *
 * @param {string} dest absolute destination file path (full filename, not dir)
 */
export function copyAbiMatchedNode(dest) {
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`  copying ${process.execPath} → ${dest}`);
  copyFileSync(process.execPath, dest);
}
