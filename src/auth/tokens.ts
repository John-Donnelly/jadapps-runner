import type { ApiClient } from "../api/client.js";
import type { PairingService } from "./pairing.js";
import type { AccessToken } from "../types.js";

const SAFETY_MARGIN_MS = 60_000;

type RefreshListener = (access: AccessToken) => void;

export class TokenManager {
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;
  private listeners: RefreshListener[] = [];

  constructor(
    private readonly api: ApiClient,
    private readonly pairing: PairingService,
  ) {}

  async getAccessToken(): Promise<AccessToken> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - SAFETY_MARGIN_MS > now) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Subscribe to access-token refresh events. Invoked exactly once per
   * successful refresh — used by LicenseManager so license rotation can
   * piggy-back on the natural access-token cycle.
   */
  onRefresh(listener: RefreshListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private async refresh(): Promise<AccessToken> {
    const refreshToken = await this.pairing.getRefreshToken();
    if (!refreshToken) {
      throw new Error("Runner is not paired. Run `jadapps-runner pair` first.");
    }
    const identity = this.pairing.loadIdentity();
    if (!identity) {
      throw new Error("Pairing record missing. Re-pair the runner.");
    }
    const access = await this.api.exchangeToken(refreshToken, identity.deviceId, identity.privKey);
    const previousSub = this.cached?.sub;
    this.cached = access;
    // Fire listeners only when the user identity actually changed (e.g.
    // after re-pair) — same sub means the refresh was a routine 15min
    // cycle and downstream caches like LicenseManager don't need to
    // discard their own state.
    if (previousSub !== access.sub) {
      for (const l of this.listeners) {
        try {
          l(access);
        } catch {
          // Listener errors must not break the refresh chain.
        }
      }
    }
    return access;
  }

  invalidate() {
    this.cached = null;
  }
}
