#!/usr/bin/env node
/**
 * Stage everything Tauri needs to ship a self-contained runner into a single
 * directory: src-tauri/runtime-bundle/
 *
 *   runtime-bundle/
 *     cli.js                  ← tsup output
 *     runner.js               ← tsup output
 *     builtin-connectors/     ← all 419 connector .js files
 *     runtime/                ← worker.js
 *     package.json            ← copy of root package.json
 *     package-lock.json       ← copy of root package-lock
 *     node_modules/           ← npm install --omit=dev result
 *
 * Tauri then bundles this whole tree as a resource. After install, Node
 * (system or bundled) runs runtime-bundle/cli.js and finds all its imports
 * via runtime-bundle/node_modules/.
 *
 * This is large (~300 MB) but gets compressed in the MSI cab.
 */

import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const stage = join(root, "src-tauri", "runtime-bundle");

if (!existsSync(dist) || !existsSync(join(dist, "cli.js"))) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}

console.log(`Staging Tauri runtime bundle at ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Copy tsup output (all of dist/) into the stage
console.log("  copying dist/ → runtime-bundle/");
cpSync(dist, stage, { recursive: true });

// Copy package.json + lockfile so npm has something to install against
console.log("  copying package.json + package-lock.json");
copyFileSync(join(root, "package.json"), join(stage, "package.json"));
copyFileSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));

// Materialize production node_modules inside the stage. `npm ci --omit=dev`
// is faster + more deterministic than `npm install`, runs install scripts so
// native deps (better-sqlite3 prebuilds, sharp libvips, @napi-rs/canvas) get
// their .node files downloaded, and guarantees the tree matches the lockfile.
console.log("  installing production node_modules (this takes a minute)…");
execSync("npm ci --omit=dev --no-audit --no-fund", {
  cwd: stage,
  stdio: "inherit",
});

// Copy the Node that just ran `npm ci` into src-tauri/binaries/ so Tauri's
// externalBin ships an ABI-matched pair: the prebuilt .node files in
// node_modules were compiled for THIS Node's NODE_MODULE_VERSION. Without
// this, dev's PATH-Node and a stale binaries/node-*.exe drift apart and
// the runner crashes with "compiled against a different Node.js version".
// Triple is hard-coded for win-x64; cross-platform staging would compute it.
const bundledNodeDest = join(
  root,
  "src-tauri",
  "binaries",
  "node-x86_64-pc-windows-msvc.exe",
);
console.log(`  copying ${process.execPath} → ${bundledNodeDest}`);
mkdirSync(dirname(bundledNodeDest), { recursive: true });
copyFileSync(process.execPath, bundledNodeDest);

console.log("Done.");
