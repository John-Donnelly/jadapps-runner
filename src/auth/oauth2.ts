import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialStore } from "../credentials/store.js";
import type { Logger } from "../log.js";

export interface OAuth2ProviderConfig {
  /** Provider name (e.g. "github", "slack", "google"). Used for logging. */
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Optional — public clients (PKCE) can omit. Confidential clients must set. */
  clientSecret?: string;
  scopes: string[];
  /** Defaults to "client_secret_post"; some providers want "client_secret_basic". */
  authStyle?: "client_secret_post" | "client_secret_basic";
}

export interface OAuth2Result {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  tokenType: string | null;
  scope: string | null;
  raw: Record<string, unknown>;
}

const REDIRECT_HOST = "127.0.0.1";

/**
 * Run a one-shot OAuth2 authorization-code flow with PKCE on the runner:
 *  1. Bind a temporary loopback HTTP server.
 *  2. Generate a PKCE code_verifier + code_challenge (S256).
 *  3. Print the authorization URL — the user opens it in their browser.
 *  4. Browser redirects back to our loopback with `code` + `state`.
 *  5. Exchange code → tokens at the provider's token endpoint.
 *  6. Return the result (caller decides whether to store it).
 *
 * The local server lives only as long as the flow; auto-shuts after the
 * code is captured (or after a 5-minute timeout).
 */
export async function runOAuth2Flow(
  provider: OAuth2ProviderConfig,
  log: Logger,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuth2Result> {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const { server, port, capture } = await startCaptureServer(state, log);
  const redirectUri = `http://${REDIRECT_HOST}:${port}/callback`;

  const authUrl = buildAuthUrl(provider, redirectUri, challenge, state);

  process.stdout.write(
    `\nAuthorize ${provider.name} by opening this URL in a browser:\n  ${authUrl}\n` +
      `\n(Listening on ${redirectUri}; closes once the redirect arrives.)\n`,
  );

  let captured: { code: string };
  try {
    captured = await Promise.race([
      capture,
      new Promise<{ code: string }>((_, reject) =>
        setTimeout(() => reject(new Error("oauth2 timed out")), timeoutMs),
      ),
    ]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  return await exchangeCode(provider, redirectUri, captured.code, verifier);
}

/** Convenience: persist the OAuth2 result into the credential store. */
export async function storeOAuth2Credential(
  store: CredentialStore,
  ref: string,
  provider: OAuth2ProviderConfig,
  result: OAuth2Result,
): Promise<void> {
  store.upsert(ref, "oauth2", {
    provider: provider.name,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    tokenType: result.tokenType,
    scope: result.scope,
  });
}

interface CaptureServer {
  server: ReturnType<typeof createServer>;
  port: number;
  capture: Promise<{ code: string }>;
}

function startCaptureServer(state: string, log: Logger): Promise<CaptureServer> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode: (v: { code: string }) => void;
    let rejectCode: (err: Error) => void;
    const capture = new Promise<{ code: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${REDIRECT_HOST}`);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          res.statusCode = 400;
          res.end(`OAuth2 error: ${error}. You can close this tab.`);
          rejectCode(new Error(`provider returned error: ${error}`));
          return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.statusCode = 400;
          res.end("OAuth2 callback missing code or state mismatch.");
          rejectCode(new Error("state mismatch or missing code"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:2em">` +
            `<h2>Authorization received</h2><p>You can close this tab.</p></body></html>`,
        );
        resolveCode({ code });
      } catch (err) {
        log.error({ err }, "callback handler crashed");
        try {
          res.statusCode = 500;
          res.end("internal error");
        } catch { /* ignore */ }
        rejectCode(err as Error);
      }
    });
    server.on("error", (err) => rejectServer(err));
    server.listen(0, REDIRECT_HOST, () => {
      const addr = server.address() as AddressInfo;
      resolveServer({ server, port: addr.port, capture });
    });
  });
}

function buildAuthUrl(
  provider: OAuth2ProviderConfig,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const sep = provider.authorizationUrl.includes("?") ? "&" : "?";
  return `${provider.authorizationUrl}${sep}${params.toString()}`;
}

async function exchangeCode(
  provider: OAuth2ProviderConfig,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<OAuth2Result> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const style = provider.authStyle ?? "client_secret_post";
  if (provider.clientSecret) {
    if (style === "client_secret_basic") {
      const enc = Buffer.from(`${provider.clientId}:${provider.clientSecret}`, "utf8").toString("base64");
      headers.authorization = `Basic ${enc}`;
    } else {
      body.set("client_secret", provider.clientSecret);
    }
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `token exchange failed (${res.status}): ${parsed.error ?? "unknown"} ${parsed.error_description ?? ""}`,
    );
  }
  const accessToken = String(parsed.access_token ?? "");
  if (!accessToken) throw new Error(`token endpoint missing access_token`);
  const expiresIn = Number(parsed.expires_in ?? 0);
  return {
    accessToken,
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : null,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    tokenType: parsed.token_type ? String(parsed.token_type) : null,
    scope: parsed.scope ? String(parsed.scope) : null,
    raw: parsed,
  };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
