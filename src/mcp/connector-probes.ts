import type { Credential } from "../types.js";

/**
 * Lightweight credential-probe library. Each probe is a tiny "does this
 * credential work?" call against the connector — auth.test, list-buckets,
 * SELECT 1, etc. Used by the credential_test MCP tool so AI agents can
 * verify a credential before wiring it into a workflow.
 *
 * Probes return { ok, status, detail? }. They never expose the secret value
 * back — only the boolean + a short detail string from the upstream API.
 */

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  detail: string;
  /** Optional structured fields the upstream returned (e.g. user.id). */
  meta?: Record<string, unknown>;
}

/**
 * Look up a probe by connector slug. Returns null if the slug isn't known
 * to the probe library — caller should surface a "no probe available" hint.
 */
export function getProbe(slug: string): ProbeFn | null {
  return PROBES[slug] ?? null;
}

type ProbeFn = (credential: Credential) => Promise<ProbeResult>;

const PROBES: Record<string, ProbeFn> = {
  // ─── Slack ────────────────────────────────────────────────────────────
  "slack-postmessage": async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://slack.com/api/auth.test",
      { authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}` },
      (json) =>
        json.ok
          ? {
              ok: true,
              detail: `team=${json.team} user=${json.user}`,
              meta: { teamId: json.team_id, userId: json.user_id },
            }
          : { ok: false, detail: json.error ?? "auth.test failed" },
    );
  },

  // ─── Airtable ─────────────────────────────────────────────────────────
  airtable: async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://api.airtable.com/v0/meta/bases",
      { authorization: `Bearer ${token}` },
      (json, status) => {
        if (status >= 400) return { ok: false, detail: json.error?.message ?? `HTTP ${status}` };
        return { ok: true, detail: `${(json.bases ?? []).length} bases visible` };
      },
    );
  },

  // ─── GitHub ───────────────────────────────────────────────────────────
  "github-issue-create": async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://api.github.com/user",
      { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      (json, status) => {
        if (status >= 400) return { ok: false, detail: json.message ?? `HTTP ${status}` };
        return { ok: true, detail: `login=${json.login}`, meta: { login: json.login, id: json.id } };
      },
    );
  },

  // ─── Notion ───────────────────────────────────────────────────────────
  "notion-page-create": async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://api.notion.com/v1/users/me",
      {
        authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
      (json, status) => {
        if (status >= 400) return { ok: false, detail: json.message ?? `HTTP ${status}` };
        return { ok: true, detail: `bot=${json.name ?? json.id}` };
      },
    );
  },

  // ─── Stripe ───────────────────────────────────────────────────────────
  stripe: async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://api.stripe.com/v1/account",
      { authorization: `Bearer ${token}` },
      (json, status) => {
        if (status >= 400)
          return { ok: false, detail: json.error?.message ?? `HTTP ${status}` };
        return { ok: true, detail: `account=${json.id} type=${json.type}` };
      },
    );
  },

  // ─── HubSpot ──────────────────────────────────────────────────────────
  hubspot: async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbe(
      "https://api.hubapi.com/account-info/v3/details",
      { authorization: `Bearer ${token}` },
      (json, status) => {
        if (status >= 400) return { ok: false, detail: json.message ?? `HTTP ${status}` };
        return { ok: true, detail: `portalId=${json.portalId ?? "?"}` };
      },
    );
  },

  // ─── Linear (GraphQL viewer) ─────────────────────────────────────────
  linear: async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    return jsonProbeWithBody(
      "https://api.linear.app/graphql",
      {
        authorization: token,
        "content-type": "application/json",
      },
      JSON.stringify({ query: "{ viewer { id name } }" }),
      (json, status) => {
        if (status >= 400 || json.errors) {
          return { ok: false, detail: json.errors?.[0]?.message ?? `HTTP ${status}` };
        }
        const v = json.data?.viewer;
        return { ok: true, detail: v ? `viewer=${v.name}` : "ok" };
      },
    );
  },

  // ─── Resend ───────────────────────────────────────────────────────────
  resend: async (credential) => {
    const token = stringField(credential, "value");
    if (!token) return notConfigured("api_key value");
    // Resend has no dedicated /me endpoint; list domains is cheap and
    // exists for any valid api key.
    return jsonProbe(
      "https://api.resend.com/domains",
      { authorization: `Bearer ${token}` },
      (json, status) => {
        if (status >= 400) return { ok: false, detail: json.message ?? `HTTP ${status}` };
        return {
          ok: true,
          detail: `${(json.data?.length ?? 0)} domains visible`,
        };
      },
    );
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────

function stringField(credential: Credential, key: string): string | null {
  const raw = credential.data?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notConfigured(field: string): ProbeResult {
  return {
    ok: false,
    status: null,
    detail: `credential is missing required field: ${field}`,
  };
}

// Probe parsers want loose JSON access (json.error?.message etc.) without
// type-narrowing pain — keep the parser argument as `any` deliberately.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProbeJson = any;

async function jsonProbe(
  url: string,
  headers: Record<string, string>,
  parse: (json: ProbeJson, status: number) => Pick<ProbeResult, "ok" | "detail" | "meta">,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { ...headers, accept: "application/json" },
    });
    const json = (await res.json().catch(() => ({}))) as ProbeJson;
    const r = parse(json, res.status);
    return { ok: r.ok, status: res.status, detail: r.detail, ...(r.meta ? { meta: r.meta } : {}) };
  } catch (err) {
    return { ok: false, status: null, detail: (err as Error).message };
  }
}

async function jsonProbeWithBody(
  url: string,
  headers: Record<string, string>,
  body: string,
  parse: (json: ProbeJson, status: number) => Pick<ProbeResult, "ok" | "detail" | "meta">,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, accept: "application/json" },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as ProbeJson;
    const r = parse(json, res.status);
    return { ok: r.ok, status: res.status, detail: r.detail, ...(r.meta ? { meta: r.meta } : {}) };
  } catch (err) {
    return { ok: false, status: null, detail: (err as Error).message };
  }
}

/**
 * Returns the list of slugs for which a probe exists. Used by the
 * credential_test MCP tool to give helpful "supported connectors" output
 * when an unsupported slug is requested.
 */
export function listProbeSlugs(): string[] {
  return Object.keys(PROBES).sort();
}
