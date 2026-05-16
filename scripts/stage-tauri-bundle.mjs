#!/usr/bin/env node
/**
 * Stage the runtime bundle for the Tauri host (macOS + Linux primary,
 * Windows fallback). The heavy lifting is in stage-runtime-bundle.mjs;
 * this script only adds the Tauri-specific extras:
 *
 *   - drops the staged bundle at src-tauri/runtime-bundle/
 *   - copies the running Node binary to src-tauri/binaries/ so Tauri's
 *     `externalBin` ships an ABI-matched pair with the staged
 *     node_modules
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stageRuntimeBundle,
  copyAbiMatchedNode,
} from "./stage-runtime-bundle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const stage = join(root, "src-tauri", "runtime-bundle");

stageRuntimeBundle(stage);

// Triple is hard-coded for win-x64; cross-platform staging would compute it.
const bundledNodeDest = join(
  root,
  "src-tauri",
  "binaries",
  "node-x86_64-pc-windows-msvc.exe",
);
copyAbiMatchedNode(bundledNodeDest);

console.log("Done.");
