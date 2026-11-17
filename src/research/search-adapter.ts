import { z } from "zod";
import type { Clock } from "../time/clock.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAtUtc: string | null;
  publishedPrecision: "second" | "day" | "month" | "unknown" | null;
  rawPayload: unknown;
}

export interface SearchResponse {
  provider: "tavily" | "fixture";
  retrievedAtUtc: string;
  results: SearchResult[];
}

export interface SearchPort {
  search(query: string, signal: AbortSignal): Promise<SearchResponse>;
}

export class SearchProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number, readonly code?: string) {
    super(message);
  }
}

const tavilySchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    content: z.string(),
    published_date: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();

function parsePublishedDate(value: string | null | undefined): { utc: string | null; precision: SearchResult["publishedPrecision"] } {
  if (!value) return { utc: null, precision: null };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { utc: null, precision: "unknown" };
  return { utc: new Date(timestamp).toISOString(), precision: value.includes(":") ? "second" : "day" };
}

export class TavilySearchPort implements SearchPort {
  constructor(private readonly apiKey: string, private readonly clock: Clock, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey) throw new TypeError("TAVILY_API_KEY is required for live search");
  }

  async search(query: string, signal: AbortSignal): Promise<SearchResponse> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_published_date: true }),
        signal,
      });
    } catch (error) {
      const cause = ((error as { cause?: NodeJS.ErrnoException }).cause ?? error) as NodeJS.ErrnoException;
      throw new SearchProviderError(cause.message, undefined, undefined, cause.code);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const header = response.headers.get("retry-after");
      const seconds = header ? Number(header) : NaN;
      const retryDateMs = header && !Number.isFinite(seconds) ? Date.parse(header) - this.clock.now().getTime() : NaN;
      const retryAfterMs = header ? Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(retryDateMs) ? Math.max(0, retryDateMs) : undefined : undefined;
      throw new SearchProviderError(`Tavily returned HTTP ${response.status}`, response.status, retryAfterMs);
    }
    const parsed = tavilySchema.parse(payload);
    return {
      provider: "tavily",
      retrievedAtUtc: this.clock.now().toISOString(),
      results: parsed.results.map((result) => {
        const published = parsePublishedDate(result.published_date);
        return {
          title: result.title,
          url: result.url,
          snippet: result.content,
          publishedAtUtc: published.utc,
          publishedPrecision: published.precision,
          rawPayload: result,
        };
      }),
    };
  }
}

export class FixtureSearchPort implements SearchPort {
  constructor(private readonly fixtures: ReadonlyMap<string, SearchResult[]>, private readonly clock: Clock) {}

  async search(query: string, signal: AbortSignal): Promise<SearchResponse> {
    signal.throwIfAborted();
    return { provider: "fixture", retrievedAtUtc: this.clock.now().toISOString(), results: this.fixtures.get(query) ?? [] };
  }
}

export function createDemoSearchPort(clock: Clock): FixtureSearchPort {
  const products = ["AcmeCRM", "BrightDesk", "CopperLeaf", "DeskNest", "Everflow"];
  const fixtures = new Map<string, SearchResult[]>(products.map((product, index) => [
    `${product} official pricing`,
    [{ title: `${product} demo pricing`, url: `https://demo.example/${product.toLowerCase()}/pricing`,
      snippet: `Demo fixture only: ${product} Basic is $${[21, 12, 15, 18, 24][index]} per user per month.`,
      publishedAtUtc: null, publishedPrecision: null, rawPayload: { source: "demo_fixture" } }],
  ]));
  return new FixtureSearchPort(fixtures, clock);
}
