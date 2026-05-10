import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { generateEd25519 } from "./keypair.js";
import type { SecretStore } from "./keychain.js";
import type { ApiClient } from "../api/client.js";
import type { DeviceIdentity } from "../types.js";
import type { RunnerConfig } from "../config.js";
import { paths } from "../config.js";

const REFRESH_KEY = "refresh_token";
const PRIVATE_KEY = "device_private_key";

export class PairingService {
  constructor(
    private readonly cfg: RunnerConfig,
    private readonly secrets: SecretStore,
    private readonly api: ApiClient,
  ) {}

  isPaired(): boolean {
    return existsSync(paths(this.cfg).pairing);
  }

  loadIdentity(): DeviceIdentity | null {
    const file = paths(this.cfg).pairing;
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as DeviceIdentity;
  }

  /**
   * Begin pairing. Returns a 6-digit code and a deep link the user opens
   * on jadapps.app to confirm. The runner then polls for confirmation.
   */
  async beginPairing(deviceName: string): Promise<{ code: string; deepLink: string; pendingId: string }> {
    if (this.isPaired()) {
      throw new Error("Runner is already paired. Run `jadapps-runner unpair` first.");
    }
    const { publicKey, privateKey } = generateEd25519();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const pendingId = randomUUID();

    // Begin first so we can persist the server's pollSecret alongside the
    // private key. The server stores only the secret's hash and silently
    // returns "not ready" on /pair/poll if the runner doesn't echo the
    // matching plaintext back — without it, the loop never resolves.
    const begin = await this.api.beginPair({
      pendingId,
      publicKey,
      code,
      deviceName,
      apiBase: this.cfg.apiBase,
    });

    writeFileSync(
      paths(this.cfg).pairing + ".pending",
      JSON.stringify({
        pendingId,
        publicKey,
        privateKey,
        code,
        deviceName,
        pollSecret: begin.pollSecret,
      }),
      "utf8",
    );

    return { code, deepLink: begin.deepLink, pendingId };
  }

  /**
   * Poll the server for pairing confirmation. Once confirmed, persist
   * the device identity and refresh token. Returns true when confirmed.
   */
  async pollPairing(timeoutMs = 5 * 60 * 1000): Promise<DeviceIdentity> {
    const pendingPath = paths(this.cfg).pairing + ".pending";
    if (!existsSync(pendingPath)) {
      throw new Error("No pairing in progress. Run `jadapps-runner pair` first.");
    }
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as {
      pendingId: string;
      publicKey: string;
      privateKey: string;
      code: string;
      deviceName: string;
      pollSecret?: string;
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.api.pollPair(pending.pendingId, pending.pollSecret);
      if (result.confirmed) {
        const identity: DeviceIdentity = {
          deviceId: result.deviceId,
          userId: result.userId,
          pubKey: pending.publicKey,
          privKey: pending.privateKey,
          pairedAt: Date.now(),
          apiBase: this.cfg.apiBase,
        };
        writeFileSync(paths(this.cfg).pairing, JSON.stringify(identity, null, 2), "utf8");
        await this.secrets.set(REFRESH_KEY, result.refreshToken);
        await this.secrets.set(PRIVATE_KEY, pending.privateKey);
        unlinkSync(pendingPath);
        return identity;
      }
      await sleep(2000);
    }
    throw new Error("Pairing timed out. Please retry `jadapps-runner pair`.");
  }

  async getRefreshToken(): Promise<string | null> {
    return this.secrets.get(REFRESH_KEY);
  }

  async unpair(): Promise<void> {
    const file = paths(this.cfg).pairing;
    if (existsSync(file)) unlinkSync(file);
    const pending = file + ".pending";
    if (existsSync(pending)) unlinkSync(pending);
    await this.secrets.delete(REFRESH_KEY);
    await this.secrets.delete(PRIVATE_KEY);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
