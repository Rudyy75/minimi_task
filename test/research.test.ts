import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/memory/db.js";
import { seedDemo } from "../src/memory/seed-demo.js";
import { SearchRunner } from "../src/research/search-runner.js";
import { createDemoSearchPort, FixtureSearchPort, SearchProviderError, TavilySearchPort, type SearchPort } from "../src/research/search-adapter.js";

const clock = { now: () => new Date("2026-11-17T18:00:00Z") };
const result = { title: "Pricing", url: "https://example.test/pricing#plans", snippet: "AcmeCRM costs $12 per user per month.", publishedAtUtc: null, publishedPrecision: null, rawPayload: { fixture: true } };

test("five searches overlap, persist independently, and exact-query cache keeps the original retrieval time", async () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, clock, "UTC");
    let active = 0, maxActive = 0, calls = 0;
    const port: SearchPort = { async search() {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active--;
      return { provider: "fixture", retrievedAtUtc: clock.now().toISOString(), results: [result] };
    } };
    const runner = new SearchRunner(db, port, clock);
    const tasks = Array.from({ length: 5 }, (_, index) => ({ query: `query ${index}`, wave: 1 as const }));
    const started = performance.now();
    const first = await runner.run({ requestTurnId: "demo-turn-crm-question", runId: "run1", waves: [tasks], signal: new AbortController().signal });
    const elapsed = performance.now() - started;
    assert.equal(maxActive, 5, JSON.stringify(first));
    assert.ok(elapsed < 5 * 80, `expected parallel wall time below 400ms, got ${elapsed}`);
    assert.equal(first.failures.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM search_calls").get().count, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM evidence").get().count, 5);
    assert.equal(JSON.parse(db.prepare("SELECT raw_payload_json FROM evidence LIMIT 1").get().raw_payload_json).provider, "fixture");

    const cached = await runner.run({ requestTurnId: "demo-turn-crm-question", runId: "run2", waves: [[tasks[0]]], signal: new AbortController().signal });
    assert.equal(calls, 5);
    assert.equal(cached.results[0]?.status, "cached");
    assert.equal(cached.results[0]?.response?.retrievedAtUtc, clock.now().toISOString());
  } finally {
    db.close();
  }
});

test("search runner retries one 429 and keeps other query failures partial", async () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, clock, "UTC");
    let firstAttempts = 0;
    const port: SearchPort = { async search(query) {
      if (query === "retry" && firstAttempts++ === 0) throw new SearchProviderError("limited", 429, 0);
      if (query === "fail") throw new Error("fixture failure");
      return { provider: "fixture", retrievedAtUtc: clock.now().toISOString(), results: [] };
    } };
    const runner = new SearchRunner(db, port, clock);
    const outcome = await runner.run({ requestTurnId: "demo-turn-crm-question", runId: "run3", waves: [[
      { query: "retry", wave: 1 }, { query: "fail", wave: 1 },
    ]], signal: new AbortController().signal });
    assert.equal(firstAttempts, 2, JSON.stringify(outcome));
    assert.equal(outcome.failures.length, 1);
    assert.equal(db.prepare("SELECT attempt_count FROM search_calls WHERE query = 'retry'").get().attempt_count, 2);
  } finally {
    db.close();
  }
});

test("client cancellation aborts pending search and preserves completed evidence", async () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, clock, "UTC");
    const controller = new AbortController();
    const port: SearchPort = { search(query, signal) {
      if (query === "fast") return Promise.resolve({ provider: "fixture", retrievedAtUtc: clock.now().toISOString(), results: [result] });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } };
    const runner = new SearchRunner(db, port, clock);
    const outcome = await runner.run({
      requestTurnId: "demo-turn-crm-question", runId: "cancel-run",
      waves: [[{ query: "fast", wave: 1 }, { query: "slow", wave: 1 }]], signal: controller.signal,
      onEvent: (event) => { if (event.type === "tool_finished" && !controller.signal.aborted) controller.abort(); },
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM evidence").get().count, 1);
    assert.equal(db.prepare("SELECT status FROM search_calls WHERE query = 'slow'").get().status, "timeout");
    assert.equal(outcome.failures.length, 1);
  } finally {
    db.close();
  }
});

test("Tavily adapter uses the bearer-authenticated search endpoint and fixture results stay labelled", async () => {
  const tavily = new TavilySearchPort("test-key", clock, (async (input, init) => {
    assert.equal(input, "https://api.tavily.com/search");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.equal((JSON.parse(String(init?.body)) as { query: string }).query, "AcmeCRM pricing");
    return Response.json({ results: [{ title: "Pricing", url: "https://example.test", content: "Basic is $12", published_date: null }] });
  }) as typeof fetch);
  const response = await tavily.search("AcmeCRM pricing", new AbortController().signal);
  assert.equal(response.provider, "tavily");
  assert.equal(response.results[0]?.snippet, "Basic is $12");
  const fixture = await new FixtureSearchPort(new Map(), clock).search("missing", new AbortController().signal);
  assert.equal(fixture.provider, "fixture");
  const demo = await createDemoSearchPort(clock).search("AcmeCRM official pricing", new AbortController().signal);
  assert.match(demo.results[0]!.snippet, /Demo fixture only/);
});

test("search plans enforce two waves and twelve total calls", async () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, clock, "UTC");
    const runner = new SearchRunner(db, new FixtureSearchPort(new Map(), clock), clock);
    await assert.rejects(() => runner.run({ requestTurnId: "demo-turn-crm-question", runId: "bad", waves: [Array.from({ length: 13 }, () => ({ query: "x", wave: 1 as const }))], signal: new AbortController().signal }), /twelve search calls/);
  } finally {
    db.close();
  }
});
