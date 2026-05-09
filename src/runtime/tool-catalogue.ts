import type { ApiClient, CatalogueEntry } from "../api/client.js";
import type { TokenManager } from "../auth/tokens.js";
import type { Logger } from "../log.js";

/**
 * Runner-side cache of the tool catalogue fetched from the website. The
 * catalogue tells us, for each orchestrator slug, the corresponding toolId,
 * runtime, tier, and bundle metadata.
 *
 * TTL: 5 minutes. The catalogue rarely changes mid-session and a stale cache
 * on the runner is harmless — when a slug is missing we refetch on demand.
 */
const TTL_MS = 5 * 60 * 1000;

export class ToolCatalogue {
  private cache: { tools: CatalogueEntry[]; fetchedAt: number } | null = null;
  private indexBySlug: Map<string, CatalogueEntry> = new Map();
  private inflight: Promise<CatalogueEntry[]> | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly tokens: TokenManager,
    private readonly log: Logger,
  ) {}

  /**
   * Returns the full catalogue, fetching if cache is empty or stale.
   * Resolves to an empty array if the runner is unpaired or the website is
   * unreachable — callers can degrade gracefully.
   */
  async list(forceRefresh = false): Promise<CatalogueEntry[]> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return this.cache.tools;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh()
      .catch((err) => {
        this.log.warn({ err }, "tool catalogue refresh failed; serving stale or empty");
        return this.cache?.tools ?? [];
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /**
   * Look up a tool by its orchestrator slug (e.g. "csv-anonymizer", "airtable").
   * Returns null when the slug is unknown to the runner.
   */
  async lookup(slug: string): Promise<CatalogueEntry | null> {
    const cached = this.indexBySlug.get(slug);
    if (cached && Date.now() - (this.cache?.fetchedAt ?? 0) < TTL_MS) return cached;
    await this.list(true).catch(() => undefined);
    return this.indexBySlug.get(slug) ?? null;
  }

  private async refresh(): Promise<CatalogueEntry[]> {
    const access = await this.tokens.getAccessToken();
    const { tools } = await this.api.fetchToolCatalogue(access.jwt);
    this.cache = { tools, fetchedAt: Date.now() };
    this.indexBySlug = new Map(tools.map((t) => [t.slug, t]));
    return tools;
  }
}
