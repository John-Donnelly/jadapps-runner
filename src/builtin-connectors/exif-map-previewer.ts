/**
 * exif-map-previewer: extracts GPS coordinates from each input image's EXIF
 * tags and emits a GeoJSON FeatureCollection plus a static OSM-tile map
 * preview URL per image. No network calls — only metadata reads.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

interface Hit { filename: string; lat: number; lon: number; timestamp?: string | undefined; mapUrl: string; }

export default async function exifMapPreviewer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "exif-map-previewer requires at least one image");
  }

  let exifr: typeof import("exifr");
  try { exifr = await import("exifr"); }
  catch (err) { return errorResult("driver_missing", `exifr not installed: ${(err as Error).message}`); }

  const hits: Hit[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  let totalIn = 0;

  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    let parsed: unknown;
    try { parsed = await exifr.parse(buf, ["GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef", "DateTimeOriginal"]); }
    catch { skipped.push({ filename: ref.filename, reason: "no parsable EXIF" }); continue; }
    const data = parsed as { latitude?: number; longitude?: number; DateTimeOriginal?: Date } | null | undefined;
    if (!data || typeof data.latitude !== "number" || typeof data.longitude !== "number") {
      skipped.push({ filename: ref.filename, reason: "no GPS coordinates" });
      continue;
    }
    hits.push({
      filename: ref.filename,
      lat: data.latitude,
      lon: data.longitude,
      timestamp: data.DateTimeOriginal instanceof Date ? data.DateTimeOriginal.toISOString() : undefined,
      mapUrl: `https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}&zoom=15`,
    });
  }
  ctx.emitProgress(totalIn);

  const geojson = {
    type: "FeatureCollection" as const,
    features: hits.map((h) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [h.lon, h.lat] },
      properties: { filename: h.filename, timestamp: h.timestamp ?? null, mapUrl: h.mapUrl },
    })),
  };
  const out = JSON.stringify(geojson, null, 2);
  const outRef = "locations.geojson";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { gpsCount: hits.length, skipped },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/geo+json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
