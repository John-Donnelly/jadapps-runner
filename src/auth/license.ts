import { request } from "undici";
import type { TokenManager } from "./tokens.js";
import type { ApiClient } from "../api/client.js";
import type { Logger } from "../log.js";

/**
 * Phase 11 license cache.
 *
 * The runner needs a valid license token to serve MCP and direct slug-
 * dispatch. License JWTs are 7 days; we proactively re-issue every 24h
 * and re-check server-side revocation hourly.
 *
 * Failure modes:
 *   - User isn't on a Developer/Enterprise plan → server returns 403,
 *     `license` stays null. MCP boot refuses; HTTP slug dispatch refuses.
 *   - Server unreachable → keep using whatever cached token we have.
 *     The runner's HTTP routes recheck `license.isValid()` on each call,
 *     so once the JWT expires (7d) the privileged surface fails closed.
 *   - Admin revocation → hourly verify call returns ok=false; we drop
 *     the cached token immediately.
 */

interface LicenseTokenPayload {
  licenseToken: string;
  expiresAt: number;
  tier: "developer" | "enterprise";
  features: ("mcp" | "api" | "workflow")[];
  jti: string;
}

interface CachedLicense extends LicenseTokenPayload {
  /** When we last confirmed the token wasn't revoked server-side. */
  lastRevocationCheckAt: number;
}

/** Refresh ~24h before expiry. */
const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;
/** Re-check revocation every hour. */
const REVOCATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export class LicenseManager {
  private cached: CachedLicense | null = null;
  private inflight: Promise<CachedLicense | null> | null = null;
  /**
   * Set when the issuance endpoint returns a hard "you're not eligible"
   * (HTTP 403 / tier_required). We don't keep retrying on every call —
   * the user upgrades, restarts the runner, and we try again from scratch.
   */
  private permanentDenial: { reason: string; upgradeUrl: string } | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly tokens: TokenManager,
    private readonly log: Logger,
  ) {
    // When the user re-pairs (TokenManager fires onRefresh on sub change),
    // drop the cached license + any permanent denial so the next call
    // re-issues against the new identity. Routine 15-minute access-token
    // refreshes don't trigger this — only identity changes.
    this.tokens.onRefresh(() => {
      this.invalidate();
    });
  }

  /**
   * Returns a valid license token, refreshing if needed. Returns null when
   * the user's plan doesn't qualify or the server is unreachable on first
   * issuance — callers gate their privileged surface on null.
   */
  async getLicense(): Promise<CachedLicense | null> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - REFRESH_LEAD_MS > now) {
      // Token still good for >24h — drop in for an hourly revocation check.
      if (now - this.cached.lastRevocationCheckAt > REVOCATION_CHECK_INTERVAL_MS) {
        await this.checkRevocation(this.cached);
      }
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    if (this.permanentDenial) return null;
    this.inflight = this.issue().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Returns true if a valid, non-revoked license exists for `feature`.
   * Used by MCP boot and by the slug dispatcher gate when the IP-protected
   * surfaces are wired up.
   */
  async hasFeature(feature: "mcp" | "api" | "workflow"): Promise<boolean> {
    const lic = await this.getLicense();
    return !!lic && lic.features.includes(feature);
  }

  /** Reports the most recent denial reason, if any. */
  permanentDenialReason(): { reason: string; upgradeUrl: string } | null {
    return this.permanentDenial;
  }

  /** Drop the cached license — used in tests and when access tokens rotate. */
  invalidate(): void {
    this.cached = null;
    this.permanentDenial = null;
  }

  private async issue(): Promise<CachedLicense | null> {
    let access;
    try {
      access = await this.tokens.getAccessToken();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "license issue: no access token");
      return null;
    }

    const url = `${this.api.apiBase}/api/runner/license`;
    const res = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (res.statusCode === 403) {
      const body = (await res.body.json().catch(() => ({}))) as {
        message?: string;
        upgrade_url?: string;
      };
      this.permanentDenial = {
        reason: body.message ?? "MCP/API requires Developer or Enterprise plan",
        upgradeUrl: body.upgrade_url ?? "https://jadapps.app/pricing",
      };
      this.log.warn(this.permanentDenial, "license denied — privileged surfaces disabled");
      return null;
    }

    if (res.statusCode >= 300) {
      const text = await res.body.text().catch(() => "");
      this.log.warn({ statusCode: res.statusCode, text }, "license issuance failed");
      return null;
    }

    const payload = (await res.body.json()) as LicenseTokenPayload;
    const cached: CachedLicense = {
      ...payload,
      lastRevocationCheckAt: Date.now(),
    };
    this.cached = cached;
    this.log.info(
      { tier: payload.tier, jti: payload.jti, expiresAt: new Date(payload.expiresAt).toISOString() },
      "license issued",
    );
    return cached;
  }

  /**
   * Calls /api/runner/license/verify so admin-initiated revocation flips
   * the runner within an hour. On verify failure we drop the cached
   * license — the next getLicense() call re-issues if eligible.
   */
  private async checkRevocation(license: CachedLicense): Promise<void> {
    let access;
    try {
      access = await this.tokens.getAccessToken();
    } catch {
      // No access token → can't verify; defer until next call.
      return;
    }

    try {
      const res = await request(`${this.api.apiBase}/api/runner/license/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ licenseToken: license.licenseToken }),
      });
      const body = (await res.body.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
      };
      if (!body.ok) {
        this.log.warn(
          { jti: license.jti, reason: body.reason ?? "unknown" },
          "license revoked or invalid; clearing cache",
        );
        this.cached = null;
        return;
      }
      license.lastRevocationCheckAt = Date.now();
    } catch (err) {
      // Don't drop the cache on transient failures — only on confirmed
      // revoke. This keeps the runner usable when the website is briefly
      // unreachable.
      this.log.debug({ err: (err as Error).message }, "license revocation check failed");
    }
  }
}
