import { createHash } from "node:crypto";
import { copyFile, link, mkdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { FileRef } from "../types.js";
import type { ScratchManager } from "../runtime/scratch.js";

/**
 * Shared helpers for the "give me a file to work on, by content OR by path"
 * pattern. Reused across `tool_run` and `workflow_run` so the MCP surface
 * presents one consistent input shape to LLM agents:
 *
 *   inputContent — raw text content (string OR array of {filename, content})
 *   inputPaths   — local-disk paths (absolute, or relative with `cwd`)
 *   files[]      — base64 inline (legacy / non-loopback clients)
 *
 * Plus `outputDir` for writing results straight to disk without round-
 * tripping through base64.
 */

export interface NormalisedContentEntry {
  filename: string;
  content: string;
  mimeType: string | undefined;
}

export interface PathInputSpec {
  path: string;
  mimeType?: string | undefined;
  filename?: string | undefined;
}

/** Pick an extension for an inline-text input based on slug + mimeType. */
export function inferContentFilename(slug: string, mimeType: string | undefined): string {
  if (mimeType) {
    const byMime: Record<string, string> = {
      "text/csv": "input.csv",
      "text/tab-separated-values": "input.tsv",
      "application/json": "input.json",
      "application/x-ndjson": "input.ndjson",
      "text/markdown": "input.md",
      "text/html": "input.html",
      "application/xml": "input.xml",
      "text/xml": "input.xml",
      "text/yaml": "input.yaml",
      "application/yaml": "input.yaml",
      "image/svg+xml": "input.svg",
      "text/plain": "input.txt",
    };
    if (mimeType in byMime) return byMime[mimeType]!;
  }
  const family = (slug.split("-")[0] ?? "").toLowerCase();
  const byFamily: Record<string, string> = {
    csv: "input.csv",
    json: "input.json",
    md: "input.md",
    markdown: "input.md",
    html: "input.html",
    pdf: "input.pdf",
    xml: "input.xml",
    yaml: "input.yaml",
    svg: "input.svg",
    excel: "input.xlsx",
    image: "input.bin",
    audio: "input.bin",
    video: "input.bin",
    archive: "input.bin",
    font: "input.bin",
    workflow: "input.txt",
  };
  return byFamily[family] ?? "input.txt";
}

/** Reshape `inputContent` (string | array | undefined) into array form. */
export function normaliseInputContent(
  raw: unknown,
  slug: string,
): NormalisedContentEntry[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    return [
      {
        filename: inferContentFilename(slug, undefined),
        content: raw,
        mimeType: undefined,
      },
    ];
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { filename?: unknown }).filename === "string" &&
        typeof (entry as { content?: unknown }).content === "string"
      ) {
        const e = entry as { filename: string; content: string; mimeType?: string };
        return { filename: e.filename, content: e.content, mimeType: e.mimeType };
      }
      throw new Error(
        "inputContent array entries must be { filename, content, mimeType? } objects",
      );
    });
  }
  return [];
}

/** Resolve an inputPaths entry against an optional `cwd`. */
export function resolveInputPath(
  path: string,
  cwd: string | undefined,
): { path: string } | { error: string } {
  if (!path || typeof path !== "string") {
    return { error: `inputPaths entry missing 'path'` };
  }
  if (isAbsolute(path)) return { path: resolve(path) };
  if (!cwd) {
    return {
      error:
        `inputPath '${path}' is relative; supply an absolute path or set 'cwd' ` +
        `to an absolute working directory so the runner knows how to resolve it.`,
    };
  }
  return { path: resolve(cwd, path) };
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveStream());
    stream.on("error", rejectStream);
  });
  return hash.digest("hex");
}

async function sha256OfBuffer(buf: Buffer): Promise<string> {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Hard-link (or copy, cross-volume) a local file into the per-run scratch
 * dir. The original is never modified; scratch teardown leaves the original
 * file alone.
 */
export async function materializePathInput(
  spec: PathInputSpec,
  scratchDir: string,
): Promise<{ ref: FileRef } | { error: string }> {
  if (!spec.path || typeof spec.path !== "string") {
    return { error: `inputPaths entry missing 'path'` };
  }
  if (!isAbsolute(spec.path)) {
    return { error: `inputPaths must be absolute; got ${spec.path}` };
  }
  const abs = resolve(spec.path);
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    return { error: `inputPath unreadable: ${abs} (${(err as Error).message})` };
  }
  if (!st.isFile()) {
    return { error: `inputPath is not a regular file: ${abs}` };
  }

  const filename = spec.filename ?? basename(abs);
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const sha = await sha256OfFile(abs);
  const ref = `${sha.slice(0, 16)}-${safeName}`;
  const target = join(scratchDir, ref);

  try {
    await link(abs, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
      await copyFile(abs, target);
    } else {
      throw err;
    }
  }

  return {
    ref: {
      ref,
      bytes: st.size,
      sha256: sha,
      mime: spec.mimeType ?? "application/octet-stream",
      filename,
    },
  };
}

/** Write a string to scratch as a file and return its FileRef. */
export async function materializeContentInput(
  entry: NormalisedContentEntry,
  scratchDir: string,
): Promise<FileRef> {
  const buf = Buffer.from(entry.content, "utf8");
  const safeName = entry.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const sha = await sha256OfBuffer(buf);
  const ref = `${sha.slice(0, 16)}-${safeName}`;
  await writeFile(join(scratchDir, ref), buf);
  return {
    ref,
    bytes: buf.length,
    sha256: sha,
    mime: entry.mimeType ?? guessMimeFromName(entry.filename),
    filename: entry.filename,
  };
}

export function guessMimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    ndjson: "application/x-ndjson",
    md: "text/markdown",
    html: "text/html",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    svg: "image/svg+xml",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

export interface WriteOutputsArgs {
  outputDir: string;
  overwrite: boolean;
  runId: string;
  outputRefs: FileRef[];
  scratch: ScratchManager;
}

/**
 * Hard-link (or copy) each output FileRef from scratch into the caller's
 * directory. Refuses to clobber existing files unless `overwrite: true`.
 * Creates the directory recursively if missing.
 */
export async function writeOutputsToDir(
  args: WriteOutputsArgs,
): Promise<{ paths: string[] } | { error: string }> {
  const target = resolve(args.outputDir);
  await mkdir(target, { recursive: true });

  const paths: string[] = [];
  for (const ref of args.outputRefs) {
    const dst = join(target, ref.filename);
    if (!args.overwrite) {
      const exists = await stat(dst).then(
        () => true,
        () => false,
      );
      if (exists) {
        return {
          error: `${dst} already exists. Pass overwrite: true to replace, or pick a different filename.`,
        };
      }
    }
    const src = args.scratch.resolve(args.runId, ref.ref);
    try {
      if (args.overwrite) {
        await stat(dst).then(
          async () => {
            const { unlink } = await import("node:fs/promises");
            await unlink(dst);
          },
          () => undefined,
        );
      }
      try {
        await link(src, dst);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
          await copyFile(src, dst);
        } else {
          throw err;
        }
      }
      paths.push(dst);
    } catch (err) {
      return { error: `failed to write ${dst}: ${(err as Error).message}` };
    }
  }
  return { paths };
}
