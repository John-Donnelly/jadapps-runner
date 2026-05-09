import type { StepResult, FileRef, Credential } from "../types.js";
import type { Logger } from "../log.js";
import type { ScratchManager } from "./scratch.js";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * BrowserWorker dispatches "browser-native" runtime tools — those that need
 * Canvas, WebCodecs, OffscreenCanvas, Web Audio, or other browser-only APIs.
 *
 * Playwright + a Chromium binary are an optional, lazy-loaded dependency:
 * - In dev/distributions where users want browser tools, `npm i playwright`
 *   provides the package; `npx playwright install chromium` provisions the
 *   browser binary.
 * - In headless/CI deployments where browser tools aren't needed, the runner
 *   never loads playwright and ships at the smaller install size.
 *
 * Browser bundles use a different ctx shape than Node bundles — they receive
 * `{ inputs, files: File[], options }` rather than `{ scratchDir, fileRefs }`,
 * because browser context can't read the runner's scratch directory directly.
 * The browser-worker materialises Files from scratch + relays them to the page.
 */
export interface BrowserToolCtx {
  toolId: string;
  inputs: Record<string, unknown>;
  /** Each file is a JS File with name + type populated. */
  files: Array<{ name: string; mimeType: string; bytes: ArrayBuffer }>;
  credentials: Record<string, Credential>;
}

export interface BrowserToolResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  /** ArrayBuffers for output files, returned to the runner as Buffers. */
  fileOutputs?: Array<{ filename: string; mimeType: string; bytes: ArrayBuffer }>;
  error?: { code: string; message: string };
}

interface DispatchOptions {
  toolId: string;
  /** Module code (UTF-8 ESM) to evaluate in page context. */
  bundleSource: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
  scratchDir: string;
  /** Soft cap — Playwright kills the page if exceeded. Default 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Lazy Playwright loader. Throws a friendly error when the package or
 * Chromium binary aren't available — the executor surfaces this to the
 * caller so they know to install playwright or set up a different runtime.
 *
 * Returns `unknown`-typed handles to avoid making playwright a hard
 * compile-time dep (it's an optional peer dependency).
 */
interface BrowserHandle {
  newContext(): Promise<BrowserContextHandle>;
  close(): Promise<void>;
}
interface BrowserContextHandle {
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}
interface PageHandle {
  setDefaultTimeout(ms: number): void;
  setContent(html: string, opts: { waitUntil: string }): Promise<void>;
  evaluate<T>(fn: (ctx: unknown) => unknown, arg: unknown): Promise<T>;
}

async function loadPlaywright(): Promise<{
  chromium: { launch(opts: { headless: boolean }): Promise<BrowserHandle> };
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pw = (await import("playwright" as string)) as any;
    return pw;
  } catch (err) {
    throw new Error(
      `Playwright is not installed. Run \`npm i playwright && npx playwright install chromium\` ` +
        `in the runner to enable browser-native tools. Underlying: ${(err as Error).message}`,
    );
  }
}

export class BrowserWorker {
  private browser: BrowserHandle | null = null;
  private launching: Promise<BrowserHandle> | null = null;

  constructor(
    private readonly log: Logger,
    private readonly scratch: ScratchManager,
  ) {}

  async dispatch(opts: DispatchOptions): Promise<StepResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let browser: BrowserHandle;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      return {
        ok: false,
        outputs: {},
        fileRefs: [],
        bytesProcessed: 0,
        durationMs: Date.now() - start,
        error: { code: "playwright_unavailable", message: (err as Error).message },
      };
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    try {
      // Materialise upstream files into ArrayBuffers + serialise the credentials
      // payload — the page can't read disk, so we ship everything in memory.
      const files: BrowserToolCtx["files"] = [];
      for (const ref of opts.fileRefs) {
        const path = this.scratch.resolve(opts.scratchDir, ref.ref);
        const buf = await readFile(path).catch(() => null);
        if (!buf) {
          await this.cleanupContext(context);
          return {
            ok: false,
            outputs: {},
            fileRefs: [],
            bytesProcessed: 0,
            durationMs: Date.now() - start,
            error: { code: "file_read_failed", message: `could not read ${ref.ref}` },
          };
        }
        files.push({
          name: ref.filename,
          mimeType: ref.mime,
          bytes: bufferToArrayBuffer(buf),
        });
      }

      // Inject the bundle source into the page as a module script. Each bundle
      // is expected to expose a `window.__jadappsTool` async function that
      // takes ctx and returns BrowserToolResult.
      await page.setContent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script type="module">
          ${opts.bundleSource}
        </script></body></html>`,
        { waitUntil: "load" },
      );

      const ctx: BrowserToolCtx = {
        toolId: opts.toolId,
        inputs: opts.inputs,
        files,
        credentials: opts.credentials,
      };

      // Pass ctx via page.evaluate so files are transferred as ArrayBuffers
      // (Playwright serialises these efficiently). Tools must return a
      // BrowserToolResult — anything else surfaces as an error.
      const evalFn = `async (passedCtx) => {
        const tool = window.__jadappsTool;
        if (typeof tool !== "function") {
          return {
            ok: false,
            outputs: {},
            error: { code: "no_tool", message: "browser bundle did not register window.__jadappsTool" },
          };
        }
        try {
          return await tool(passedCtx);
        } catch (e) {
          return {
            ok: false,
            outputs: {},
            error: { code: "tool_threw", message: e?.message ?? "browser tool threw" },
          };
        }
      }`;
      const result = (await page.evaluate(
        new Function("return " + evalFn)() as (ctx: unknown) => unknown,
        ctx,
      )) as BrowserToolResult;

      // Persist any output files back into the scratch dir so downstream
      // steps (or the /v1/tools/:slug/run output-copy logic) can pick them up.
      const outRefs: FileRef[] = [];
      let totalBytesOut = 0;
      if (result.ok && result.fileOutputs) {
        for (const out of result.fileOutputs) {
          const buf = Buffer.from(out.bytes);
          const sha = createHash("sha256").update(buf).digest("hex");
          const safeName = out.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
          const ref = `${sha.slice(0, 16)}-${safeName}`;
          await writeFile(join(opts.scratchDir, ref), buf);
          outRefs.push({
            ref,
            bytes: buf.length,
            sha256: sha,
            mime: out.mimeType,
            filename: out.filename,
          });
          totalBytesOut += buf.length;
        }
      }

      await this.cleanupContext(context);

      return {
        ok: result.ok,
        outputs: result.outputs ?? {},
        fileRefs: outRefs,
        bytesProcessed: totalBytesOut,
        durationMs: Date.now() - start,
        ...(result.ok ? {} : { error: result.error }),
      };
    } catch (err) {
      await this.cleanupContext(context);
      const e = err as Error;
      return {
        ok: false,
        outputs: {},
        fileRefs: [],
        bytesProcessed: 0,
        durationMs: Date.now() - start,
        error: { code: "browser_threw", message: e.message },
      };
    }
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = this.launchBrowser()
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  private async launchBrowser(): Promise<BrowserHandle> {
    const pw = await loadPlaywright();
    this.log.info("launching headless chromium for browser-native tool dispatch");
    return pw.chromium.launch({ headless: true });
  }

  private async cleanupContext(ctx: BrowserContextHandle): Promise<void> {
    try {
      await ctx.close();
    } catch (err) {
      this.log.warn({ err }, "browser context close failed");
    }
  }
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  // Copy out into a dedicated ArrayBuffer to avoid sharing memory with
  // adjacent buffers in Node's pool (and to side-step ArrayBuffer vs
  // SharedArrayBuffer type narrowing on Buffer.buffer).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}
