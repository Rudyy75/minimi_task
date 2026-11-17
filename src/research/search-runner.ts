import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import type { ServerEvent } from "../app/events.js";
import type { Clock } from "../time/clock.js";
import { SearchProviderError, type SearchPort, type SearchResponse, type SearchResult } from "./search-adapter.js";

export interface SearchTask { query: string; wave: 1 | 2 }
export interface SearchTaskResult { callId: string; query: string; wave: 1 | 2; status: string; response?: SearchResponse; error?: string }

interface RunOptions {
  requestTurnId: string;
  runId: string;
  waves: readonly (readonly SearchTask[])[];
  signal: AbortSignal;
  runDeadlineMs?: number;
  taskDeadlineMs?: number;
  onEvent?: (event: ServerEvent) => void;
}

const MAX_CONCURRENCY = 5;
const MAX_CALLS = 12;
const CACHE_MS = 5 * 60_000;
const retryableCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

export async function mapSettled<T, R>(items: readonly T[], limit: number, signal: AbortSignal, fn: (item: T, signal: AbortSignal) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = { status: "fulfilled", value: await fn(items[index], signal) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  for (let index = 0; index < results.length; index++) {
    results[index] ??= { status: "rejected", reason: signal.reason ?? new DOMException("Aborted", "AbortError") };
  }
  return results;
}

function canonicalUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("Search result URL must use HTTP or HTTPS");
  url.hash = "";
  return url;
}

function retryDelay(error: unknown): number | null {
  if (!(error instanceof SearchProviderError)) return null;
  if (error.status !== 429 && !(error.status !== undefined && error.status >= 500) && !retryableCodes.has(error.code ?? "")) return null;
  return error.retryAfterMs ?? 100;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class SearchRunner {
  private readonly cache = new Map<string, { expiresAt: number; response: SearchResponse }>();

  constructor(private readonly db: Database.Database, private readonly port: SearchPort, private readonly clock: Clock) {}

  async run(options: RunOptions): Promise<{ results: SearchTaskResult[]; failures: string[] }> {
    if (options.waves.length > 2 || options.waves.flat().length > MAX_CALLS || options.waves.some((wave) => wave.length > MAX_CALLS)) {
      throw new RangeError("A research run supports at most two waves and twelve search calls");
    }
    if (options.waves.some((wave, index) => wave.some((task) => task.wave !== index + 1 || !task.query.trim()))) {
      throw new TypeError("Search tasks must have a non-empty query and match their wave number");
    }
    const runSignal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(options.runDeadlineMs ?? 8_000)))]);
    const results: SearchTaskResult[] = [];
    const failures: string[] = [];
    for (const wave of options.waves) {
      if (runSignal.aborted) break;
      const settled = await mapSettled(wave, MAX_CONCURRENCY, runSignal, (task, signal) => this.runTask(task, options, signal));
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          results.push(result.value);
          if (result.value.status !== "ok" && result.value.status !== "cached") failures.push(`${wave[index].query}: ${result.value.error ?? result.value.status}`);
        }
        else failures.push(`${wave[index].query}: ${String(result.reason)}`);
      });
    }
    return { results, failures };
  }

  private async runTask(task: SearchTask, options: RunOptions, runSignal: AbortSignal): Promise<SearchTaskResult> {
    const callId = randomUUID();
    const startedAtMs = this.clock.now().getTime();
    const started = performance.now();
    runSignal.throwIfAborted();
    const runRemainingMs = Math.max(1, Math.ceil(Math.min(options.runDeadlineMs ?? 8_000, options.taskDeadlineMs ?? 3_000) - (performance.now() - started)));
    const taskSignal = AbortSignal.any([runSignal, AbortSignal.timeout(Math.min(options.taskDeadlineMs ?? 3_000, runRemainingMs))]);
    options.onEvent?.({ type: "tool_started", callId, query: task.query, wave: task.wave });
    const cached = this.cache.get(task.query);
    if (cached && cached.expiresAt > startedAtMs) {
      this.persist(callId, task, options.requestTurnId, startedAtMs, startedAtMs, 0, "cached", 0, undefined, cached.response.results, cached.response.retrievedAtUtc, cached.response.provider);
      options.onEvent?.({ type: "tool_finished", callId, status: "cached", latencyMs: 0 });
      return { callId, ...task, status: "cached", response: cached.response };
    }
    this.cache.delete(task.query);

    let attempts = 0;
    let error: unknown;
    for (; attempts < 2; attempts++) {
      try {
        const response = await this.port.search(task.query, taskSignal);
        const finishedAtMs = this.clock.now().getTime();
        const latencyMs = Math.round(performance.now() - started);
        this.persist(callId, task, options.requestTurnId, startedAtMs, finishedAtMs, attempts + 1, "ok", latencyMs, undefined, response.results, response.retrievedAtUtc, response.provider);
        this.cache.set(task.query, { expiresAt: finishedAtMs + CACHE_MS, response });
        options.onEvent?.({ type: "tool_finished", callId, status: response.provider, latencyMs });
        return { callId, ...task, status: "ok", response };
      } catch (reason) {
        error = reason;
        const delayMs = retryDelay(reason);
        const remainingMs = Math.min(options.taskDeadlineMs ?? 3_000, options.runDeadlineMs ?? 8_000) - (performance.now() - started);
        if (attempts > 0 || delayMs === null || taskSignal.aborted || remainingMs <= delayMs + 50) break;
        try { await wait(delayMs, taskSignal); } catch (abortError) { error = abortError; break; }
      }
    }
    const finishedAtMs = this.clock.now().getTime();
    const latencyMs = Math.round(performance.now() - started);
    const status = taskSignal.aborted ? "timeout" : error instanceof SearchProviderError && error.status === 429 ? "rate_limited" : "failed";
    this.persist(callId, task, options.requestTurnId, startedAtMs, finishedAtMs, Math.min(attempts + 1, 2), status, latencyMs,
      error instanceof SearchProviderError ? error.code ?? String(error.status ?? "provider_error") : "network_error", [], null, undefined);
    options.onEvent?.({ type: "tool_finished", callId, status, latencyMs });
    return { callId, ...task, status, error: error instanceof Error ? error.message : String(error) };
  }

  private persist(callId: string, task: SearchTask, requestTurnId: string, startedAtMs: number, finishedAtMs: number,
    attempts: number, status: string, latencyMs: number, errorCode: string | undefined, results: SearchResult[], retrievedAtUtc: string | null, provider: SearchResponse["provider"] | undefined): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO search_calls
        (id, request_turn_id, wave, query, started_at_ms, finished_at_ms, attempt_count, status, provider_latency_ms, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(callId, requestTurnId, task.wave, task.query, startedAtMs, finishedAtMs, attempts, status, latencyMs, errorCode ?? null);
      if (!retrievedAtUtc) return;
      const addEvidence = this.db.prepare(`INSERT INTO evidence
        (id, search_call_id, url, canonical_url, domain, title, snippet, published_at_utc,
         published_precision, retrieved_at_utc, retrieved_at_ms, result_rank, content_sha256, raw_payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      results.forEach((result, index) => {
        const url = canonicalUrl(result.url);
        const hash = createHash("sha256").update(`${result.title}\n${result.snippet}\n${url.href}`).digest("hex");
        addEvidence.run(randomUUID(), callId, result.url, url.href, url.hostname, result.title, result.snippet,
          result.publishedAtUtc, result.publishedPrecision, retrievedAtUtc, Date.parse(retrievedAtUtc), index + 1, hash,
          JSON.stringify({ provider, result: result.rawPayload }));
      });
    })();
  }
}
