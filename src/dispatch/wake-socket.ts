import WebSocket from "ws";
import type { Logger } from "../log.js";
import type { TokenManager } from "../auth/tokens.js";

/**
 * Optional WSS client for the @jadapps/runner-wss companion Worker. Calls
 * `onWake()` when the server pushes a wake event so the poller can skip
 * its 10s sleep and claim immediately. Falls back gracefully — if the
 * URL isn't configured or the connection fails repeatedly, polling
 * still drives dispatch on its own.
 */
export class WakeSocket {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectAttempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wssUrl: string,
    private readonly tokens: TokenManager,
    private readonly onWake: () => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.connectOnce();
      } catch (err) {
        this.log.debug({ err }, "wake socket connect failed");
      }
      if (this.stopRequested) return;
      // Exponential backoff with jitter, capped at 60s.
      const base = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 6));
      const jitter = Math.floor(Math.random() * 500);
      this.reconnectAttempt += 1;
      await sleep(base + jitter);
    }
  }

  private async connectOnce(): Promise<void> {
    const access = await this.tokens.getAccessToken();
    const url = `${this.wssUrl.replace(/^http/, "ws")}/api/runner/wss?token=${encodeURIComponent(access.jwt)}`;
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.log.info("wake socket connected");
        this.startPing();
      });
      ws.on("message", (data) => {
        const text = data.toString("utf8");
        try {
          const msg = JSON.parse(text) as { type?: string };
          if (msg.type === "wake") {
            this.log.debug("wake received");
            this.onWake();
          }
        } catch {
          /* ignore non-JSON */
        }
      });
      ws.on("close", () => {
        this.clearPing();
        this.ws = null;
        resolve();
      });
      ws.on("error", (err) => {
        this.log.debug({ err: err.message }, "wake socket error");
      });
    });
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping", at: Date.now() }));
      } catch {
        /* ignore */
      }
    }, 30_000);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
