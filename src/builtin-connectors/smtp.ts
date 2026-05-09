/**
 * Built-in SMTP connector. Uses the `nodemailer` package from node_modules.
 *
 * Inputs (config object on ctx.inputs):
 *   action:        "sendEmail"                                  (required)
 *   from:          string (required)
 *   to:            string | string[] (required)
 *   subject:       string (required)
 *   text?:         string             — plain-text body (falls back to upstream)
 *   html?:         string             — HTML body
 *   cc?:           string | string[]
 *   bcc?:          string | string[]
 *   replyTo?:      string
 *   attachUpstreamFile? boolean       — attach the first upstream fileRef
 *   credentialRef: string (required)  — runner credential (custom with
 *                                       host + port + secure + username + password)
 *
 * Returns nodemailer's response as `outputs.response`.
 */

import type { StepResult, Credential, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  credentials: Record<string, Credential>;
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function smtp(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const config = ctx.inputs;
  const action = String(config.action ?? "sendEmail").trim();

  const credentialRef = config.credentialRef as string | undefined;
  if (!credentialRef) {
    return errorResult(
      "missing_credential",
      "smtp requires `credentialRef` (custom with host + port + username + password)",
    );
  }
  const credential = ctx.credentials[credentialRef];
  if (!credential) {
    return errorResult("credential_missing", `credential ${credentialRef} not found on runner`);
  }
  const auth = extractAuth(credential);
  if (!auth) {
    return errorResult(
      "bad_credential",
      `credential ${credentialRef} needs host + port + username + password`,
    );
  }

  if (action !== "sendEmail") {
    return errorResult("unknown_action", `unknown smtp action: ${action}`);
  }

  const from = String(config.from ?? "").trim();
  const toList = normaliseAddress(config.to);
  const subject = String(config.subject ?? "").trim();
  if (!from || toList.length === 0 || !subject) {
    return errorResult(
      "missing_fields",
      "sendEmail requires `from`, `to`, and `subject`",
    );
  }

  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch (err) {
    return errorResult(
      "driver_missing",
      `nodemailer not installed: ${(err as Error).message}`,
    );
  }

  const transport = nodemailer.createTransport({
    host: auth.host,
    port: auth.port,
    secure: auth.secure,
    auth: {
      user: auth.username,
      pass: auth.password,
    },
  });

  const mail: import("nodemailer").SendMailOptions = {
    from,
    to: toList,
    subject,
  };
  if (config.html) mail.html = String(config.html);

  let text = config.text as string | undefined;
  if (text == null && !config.html) {
    text = (await tryReadFirstFileText(ctx)) ?? undefined;
  }
  if (text != null) mail.text = String(text);

  const cc = normaliseAddress(config.cc);
  if (cc.length > 0) mail.cc = cc;
  const bcc = normaliseAddress(config.bcc);
  if (bcc.length > 0) mail.bcc = bcc;
  if (config.replyTo) mail.replyTo = String(config.replyTo);

  // Optional attachment from upstream fileRef
  const firstRef = ctx.fileRefs[0];
  if (config.attachUpstreamFile && firstRef) {
    const fs = await import("node:fs/promises");
    try {
      const path = ctx.scratchDir + "/" + firstRef.ref;
      const buf = await fs.readFile(path);
      mail.attachments = [
        {
          filename: firstRef.filename,
          content: buf,
          contentType: firstRef.mime,
        },
      ];
    } catch (err) {
      return errorResult(
        "attachment_read_failed",
        `Could not read upstream file for attachment: ${(err as Error).message}`,
      );
    }
  }

  try {
    const info = await transport.sendMail(mail);
    const bytes = JSON.stringify(info).length;
    ctx.emitProgress(bytes);
    return {
      ok: true,
      outputs: {
        response: info,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
      },
      fileRefs: [],
      bytesProcessed: bytes,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as Error & { code?: string; responseCode?: number };
    return {
      ok: false,
      outputs: {},
      fileRefs: [],
      bytesProcessed: 0,
      durationMs: Date.now() - start,
      error: {
        code: `smtp_${e.code ?? e.responseCode ?? "error"}`,
        message: e.message,
      },
    };
  } finally {
    transport.close();
  }
}

function extractAuth(credential: Credential): {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
} | null {
  if (credential.type !== "custom") return null;
  const host = credential.data.host as string | undefined;
  const portRaw = credential.data.port;
  const username = credential.data.username as string | undefined;
  const password = credential.data.password as string | undefined;
  const secure = Boolean(credential.data.secure ?? false);
  const port = Number(portRaw);
  if (!host || !Number.isFinite(port) || !username || !password) return null;
  return { host, port, secure, username, password };
}

function normaliseAddress(input: unknown): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

async function tryReadFirstFileText(ctx: ToolContext): Promise<string | null> {
  const ref = ctx.fileRefs[0];
  if (!ref) return null;
  try {
    const fs = await import("node:fs/promises");
    const path = ctx.scratchDir + "/" + ref.ref;
    const buf = await fs.readFile(path);
    if (buf.length > 64 * 1024) {
      return buf.subarray(0, 64 * 1024).toString("utf8") + "…[truncated]";
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function errorResult(code: string, message: string): StepResult {
  return {
    ok: false,
    outputs: {},
    fileRefs: [],
    bytesProcessed: 0,
    durationMs: 0,
    error: { code, message },
  };
}
