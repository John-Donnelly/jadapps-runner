/**
 * xml-to-json: converts XML to JSON using a minimal hand-rolled parser.
 * Element children become an object's properties (single child stays as
 * object, multiple same-name children become arrays). Attributes appear
 * under "@attr"; text content under "#text".
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

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export default async function xmlToJson(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "xml-to-json requires one XML input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const stripped = text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tree = parse(stripped);
  if (!tree) return errorResult("parse_error", "could not parse XML");
  const json = nodeToObject(tree);

  const out = JSON.stringify(json, null, 2);
  const outRef = `${(ref.filename ?? "doc").replace(/\.xml$/i, "")}.json`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { rootElement: tree.name },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parse(text: string): XmlNode | null {
  const tagRe = /<\/?([A-Za-z_:][A-Za-z0-9_.:-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let pos = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const between = text.slice(pos, match.index).replace(/^\s+|\s+$/g, "");
    if (between && stack.length > 0) {
      const top = stack[stack.length - 1]!;
      top.text += decodeEntities(between);
    }
    pos = tagRe.lastIndex;
    const isClose = match[0].startsWith("</");
    const name = match[1]!;
    const isSelfClose = match[3] === "/";
    if (isClose) {
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const am of (match[2] ?? "").matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g)) {
      attributes[am[1]!] = decodeEntities(am[2]!);
    }
    const node: XmlNode = { name, attributes, children: [], text: "" };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    if (!root) root = node;
    if (!isSelfClose) stack.push(node);
  }
  return root;
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
}

function nodeToObject(node: XmlNode): unknown {
  if (node.children.length === 0 && Object.keys(node.attributes).length === 0) {
    return node.text || null;
  }
  const obj: Record<string, unknown> = {};
  if (Object.keys(node.attributes).length > 0) obj["@attr"] = node.attributes;
  if (node.text) obj["#text"] = node.text;
  const childGroups = new Map<string, XmlNode[]>();
  for (const c of node.children) {
    const list = childGroups.get(c.name) ?? [];
    list.push(c);
    childGroups.set(c.name, list);
  }
  for (const [name, children] of childGroups) {
    if (children.length === 1) obj[name] = nodeToObject(children[0]!);
    else obj[name] = children.map(nodeToObject);
  }
  return obj;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
