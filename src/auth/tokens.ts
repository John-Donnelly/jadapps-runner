import type { ApiClient } from "../api/client.js";
import type { PairingService } from "./pairing.js";
import type { AccessToken } from "../types.js";

const SAFETY_MARGIN_MS = 60_000;

export class TokenManager {
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

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
    this.cached = access;
    return access;
  }

  invalidate() {
    this.cached = null;
  }
}
