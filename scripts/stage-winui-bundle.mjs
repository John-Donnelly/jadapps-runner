#!/usr/bin/env node
/**
 * Stage the runtime bundle for the WinUI3 host (Windows primary). The
 * heavy lifting is in stage-runtime-bundle.mjs; this script only adds
 * the WinUI3-specific extras:
 *
 *   - drops the staged bundle at src-winui/JadAppsRunner/Assets/runtime-bundle/
 *     so the MSIX `Package` task picks it up as packaged content.
 *   - copies the running Node binary alongside the bundle (same
 *     ABI-pairing concern as the Tauri stager).
 *
 * The WinUI3 .csproj configures the runtime-bundle directory as
 * `Content` with `CopyToOutputDirectory=PreserveNewest` so it ships
 * inside the .msix.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stageRuntimeBundle,
  copyAbiMatchedNode,
} from "./stage-runtime-bundle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const stage = join(
  root,
  "src-winui",
  "JadAppsRunner.Host",
  "Assets",
  "runtime-bundle",
);

stageRuntimeBundle(stage);

const bundledNodeDest = join(stage, "node.exe");
copyAbiMatchedNode(bundledNodeDest);

console.log("Done.");
