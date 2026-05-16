import { writeFileSync, existsSync } from "node:fs";
import { hostname, platform } from "node:os";
import { generateEd25519 } from "./keypair.js";
import type { SecretStore } from "./keychain.js";
import type { ApiClient } from "../api/client.js";
import type { DeviceIdentity } from "../types.js";
import type { RunnerConfig } from "../config.js";
import { paths } from "../config.js";
import type { Logger } from "../log.js";

const REFRESH_KEY = "refresh_token";
const PRIVATE_KEY = "device_private_key";

export interface PreauthRedeemOptions {
  /** Friendly device name shown to the user in jadapps.app → Devices. */
  deviceName?: string;
  /**
   * Platform tag forwarded to the server for telemetry / install-source
   * tracking. Defaults to "<os>-runner" (e.g. "win32-runner"); the WinUI3
   * and Tauri shells override to "win32-msix" / "win32-tauri" etc.
   */
  platformTag?: string;
}

export interface PreauthRedeemDeps {
  cfg: RunnerConfig;
  secrets: SecretStore;
  api: ApiClient;
  log: Logger;
}

/**
 * Single-shot pairing via a server-minted preauth token. The token is
 * issued by jadapps.app under the user's signed-in session, then handed
 * to this runner via one of:
 *
 *   - Custom URL protocol (`jadapps-runner://pair?token=...`) — Windows
 *     MSIX / macOS LaunchServices / Linux .desktop registrations.
 *   - Environment variable `JADAPPS_PREAUTH_TOKEN` set by the installer.
 *   - Marker file `<dataDir>/preauth.json` dropped by the installer or
 *     companion download.
 *
 * The redeemer generates an Ed25519 keypair locally (the private key
 * never leaves the device), exchanges the token + public key for a
 * refresh token + deviceId, and persists the pairing record. After
 * redemption the user is fully paired — same end state as the
 * interactive `pair` flow.
 */
export class PreauthRedeemer {
  constructor(private readonly deps: PreauthRedeemDeps) {}

  /**
   * Returns true if a pairing record already exists. Callers should
   * check this before redeeming — re-redeeming an already-paired runner
   * would orphan the previous deviceId on the server.
   */
  isPaired(): boolean {
    return existsSync(paths(this.deps.cfg).pairing);
  }

  /**
   * Redeem a preauth token. Throws on invalid token, expired token, or
   * any network failure — there's no retry that will fix a bad token,
   * so we surface the error rather than swallowing it.
   *
   * On success, the runner is fully paired: `pairing.json` exists,
   * refresh token + private key are in the keychain (or 0600 fallback),
   * and subsequent `TokenManager.getAccessToken()` calls will succeed.
   */
  async redeem(
    preauthToken: string,
    opts: PreauthRedeemOptions = {},
  ): Promise<DeviceIdentity> {
    if (!preauthToken || typeof preauthToken !== "string") {
      throw new Error("preauthToken is required");
    }
    if (this.isPaired()) {
      throw new Error(
        "Runner is already paired. Run `jadapps-runner unpair` first to re-pair.",
      );
    }

    const deviceName = opts.deviceName?.trim() || hostname();
    const platformTag = opts.platformTag?.trim() || `${platform()}-runner`;

    const { publicKey, privateKey } = generateEd25519();
    this.deps.log.info(
      { deviceName, platformTag, apiBase: this.deps.cfg.apiBase },
      "redeeming preauth token",
    );

    const result = await this.deps.api.redeemPreauth({
      preauthToken,
      publicKey,
      deviceName,
      platform: platformTag,
    });

    const identity: DeviceIdentity = {
      deviceId: result.deviceId,
      userId: result.userId,
      pubKey: publicKey,
      privKey: privateKey,
      pairedAt: Date.now(),
      apiBase: this.deps.cfg.apiBase,
    };
    writeFileSync(
      paths(this.deps.cfg).pairing,
      JSON.stringify(identity, null, 2),
      "utf8",
    );
    await this.deps.secrets.set(REFRESH_KEY, result.refreshToken);
    await this.deps.secrets.set(PRIVATE_KEY, privateKey);

    this.deps.log.info(
      { deviceId: identity.deviceId, userId: identity.userId },
      "preauth redeemed; runner paired",
    );
    return identity;
  }
}
