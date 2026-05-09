/**
 * pgp-message-signer: PGP-signs (or signs+encrypts) a text message using a
 * provided private key. Optional encryption requires a public key for the
 * recipient. Output is ASCII-armored PGP.
 *
 * Inputs: fileRefs[0] = message text, fileRefs[1] = private key (.asc),
 * optional fileRefs[2] = recipient public key for encrypt-and-sign.
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

export default async function pgpMessageSigner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "pgp-message-signer requires a message file and a private key");
  }

  const cfg = ctx.inputs ?? {};
  const passphrase = cfg.passphrase != null ? String(cfg.passphrase) : "";

  let openpgp: typeof import("openpgp");
  try { openpgp = await import("openpgp"); }
  catch (err) { return errorResult("driver_missing", `openpgp not installed: ${(err as Error).message}`); }

  const messageRef = ctx.fileRefs[0]!;
  const keyRef = ctx.fileRefs[1]!;
  const recipientRef = ctx.fileRefs[2];

  const messagePath = join(ctx.scratchDir, messageRef.ref);
  const keyPath = join(ctx.scratchDir, keyRef.ref);
  const totalIn = sizeOrFallback(messagePath, messageRef.bytes) + sizeOrFallback(keyPath, keyRef.bytes);
  const messageText = await readFile(messagePath, "utf8");
  const armoredKey = await readFile(keyPath, "utf8");
  ctx.emitProgress(totalIn);

  let privateKey: import("openpgp").PrivateKey;
  try {
    const parsed = await openpgp.readPrivateKey({ armoredKey });
    privateKey = passphrase ? await openpgp.decryptKey({ privateKey: parsed, passphrase }) : parsed;
  } catch (err) {
    return errorResult("key_error", `private key load failed: ${(err as Error).message}`);
  }

  let signed: string;
  try {
    if (recipientRef) {
      const recipientPath = join(ctx.scratchDir, recipientRef.ref);
      const recipientArmor = await readFile(recipientPath, "utf8");
      const recipientKey = await openpgp.readKey({ armoredKey: recipientArmor });
      const message = await openpgp.createMessage({ text: messageText });
      signed = (await openpgp.encrypt({ message, encryptionKeys: recipientKey, signingKeys: privateKey })) as string;
    } else {
      const message = await openpgp.createCleartextMessage({ text: messageText });
      signed = (await openpgp.sign({ message, signingKeys: privateKey })) as string;
    }
  } catch (err) {
    return errorResult("sign_error", `signing failed: ${(err as Error).message}`);
  }

  const outRef = recipientRef ? "signed-encrypted.asc" : "signed.asc";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, signed, "utf8");

  return {
    ok: true,
    outputs: { encrypted: recipientRef != null, signerKeyId: privateKey.getKeyID().toHex() },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(signed, "utf8"), sha256: "", mime: "application/pgp-signature", filename: outRef }],
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
