import assert from "node:assert/strict";
import test from "node:test";
import { createRequestContext } from "../src/app/context.js";
import { openDatabase } from "../src/memory/db.js";
import { recallByInterval } from "../src/memory/recall.js";
import { seedDemo } from "../src/memory/seed-demo.js";
import { createDemoSearchPort } from "../src/research/search-adapter.js";
import { SearchRunner } from "../src/research/search-runner.js";
import { resolveAnchor } from "../src/time/resolve-anchor.js";
import { buildSearchWaves } from "../src/app/router.js";
import { extractPrice, verifySearchResults } from "../src/verify/pipeline.js";

test("demo search is extracted, checked, cited, and committed as an immutable snapshot", async () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(extractPrice({ id: "x", url: "https://demo.example", title: "Pricing", snippet: "Demo fixture only: AcmeCRM Basic is USD 21 per user per month." }, "entity", "2026-11-17T18:00:00Z")?.value.kind, "price");
    assert.equal(extractPrice({ id: "x", url: "https://demo.example", title: "Pricing", snippet: "AcmeCRM is $21 per user per month." }, "entity", "2026-11-17T18:00:00Z"), null);
    assert.equal(extractPrice({ id: "x", url: "https://demo.example", title: "Pricing", snippet: "USD 21 per user per month." }, "entity", "2026-11-17T18:00:00Z"), null);
    const clock = { now: () => new Date("2026-11-17T18:00:00Z") };
    seedDemo(db, clock, "UTC");
    const context = createRequestContext(clock, { conversationId: "demo-conversation", timeZone: "UTC", locale: "en-US" });
    const anchor = resolveAnchor("What changed in the CRM shortlist from Monday?", context.nowUtc, "UTC")!;
    const recalled = recallByInterval(db, "demo-conversation", anchor.primary, "CRM shortlist");
    const entities = recalled.episodes.flatMap(({ entities }) => entities);
    const runner = new SearchRunner(db, createDemoSearchPort(clock), clock);
    const results = await runner.run({ requestTurnId: "demo-turn-crm-question", runId: "pipeline-test",
      waves: [entities.map(({ display_name }) => ({ query: `${display_name} official pricing`, wave: 1 as const }))], signal: new AbortController().signal });
    const events: unknown[] = [];
    const verified = await verifySearchResults(db, { context, requestTurnId: "demo-turn-crm-question", runId: "pipeline-test",
      question: "What changed in the CRM shortlist from Monday?", episodeIds: recalled.episodes.map(({ id }) => id),
      entityIds: new Map(entities.map(({ display_name, id }) => [display_name.toLowerCase(), id])),
      results: results.results, providerFailures: results.failures, signal: new AbortController().signal, send: (event) => events.push(event) });
    assert.match(verified.answer, /acmecrm: confirmed change/);
    assert.match(verified.answer, /4 comparisons remain unverified/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE answer_turn_id = (SELECT id FROM turns WHERE run_id = 'pipeline-test' AND role = 'assistant')").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verification_evidence").get().count, 5);
    assert.ok(events.some((event) => (event as { type?: string }).type === "answer_final"));

    const model: { complete(prompt: string): Promise<string> } = { async complete(prompt) {
      if (prompt.startsWith("Extract only")) {
        const excerpts = JSON.parse(prompt.slice(prompt.indexOf("Evidence: ") + "Evidence: ".length)) as { id: string; snippet: string }[];
        const excerpt = excerpts.find(({ snippet }) => snippet.includes("AcmeCRM Basic"))!;
        return JSON.stringify([{ entityName: "AcmeCRM", predicate: "plan.price", value: { kind: "price", plan: "Basic", amountDecimal: "21", currency: "USD", basis: "seat", interval: "month", billing: "monthly", usageUnit: null, minimumSeats: null, region: null },
          evidence: [{ evidenceId: excerpt.id, stance: "supports", quote: excerpt.snippet, quoteStart: 0, quoteEnd: excerpt.snippet.length }] }]);
      }
      const data = JSON.parse(prompt.slice(prompt.indexOf("Data: ") + "Data: ".length)) as { evidence: { id: string }[] };
      return `AcmeCRM remains unchanged. [[${data.evidence[0].id}]]`;
    } };
    const acme = entities.find(({ display_name }) => display_name === "AcmeCRM")!;
    const modelAnswer = await verifySearchResults(db, { context, requestTurnId: "demo-turn-crm-question", runId: "model-pipeline-test",
      question: "What changed in the CRM shortlist from Monday?", episodeIds: recalled.episodes.map(({ id }) => id),
      entityIds: new Map([["acmecrm", acme.id]]), results: results.results, providerFailures: [], llm: model,
      signal: new AbortController().signal, send: () => {} });
    assert.match(modelAnswer.answer, /acmecrm: unchanged/);

    const scenarios = [
      { prompt: "Recheck the November 3 audit logs and pricing claims.", phrase: /No confirmed changes/, anchor: "3 November" },
      { prompt: "What changed in last Tuesday's Postgres hosting comparison?", phrase: /not comparable/, anchor: "last Tuesday" },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const resolved = resolveAnchor(scenario.prompt, context.nowUtc, "UTC")!;
      const recalled = recallByInterval(db, "demo-conversation", resolved.primary, scenario.prompt);
      const products = recalled.episodes.flatMap(({ entities }) => entities);
      const waves = buildSearchWaves(scenario.prompt, "VERIFY_TEMPORAL", products.map(({ display_name }) => display_name));
      const outcome = await runner.run({ requestTurnId: index ? "demo-turn-postgres-question" : "demo-turn-november-3-question",
        runId: `pipeline-benchmark-${index}`, waves, signal: new AbortController().signal });
      const verified = await verifySearchResults(db, { context, requestTurnId: index ? "demo-turn-postgres-question" : "demo-turn-november-3-question",
        runId: `pipeline-benchmark-${index}`, question: scenario.prompt, episodeIds: recalled.episodes.map(({ id }) => id),
        entityIds: new Map(products.map(({ display_name, id }) => [display_name.toLowerCase(), id])), results: outcome.results,
        providerFailures: outcome.failures, signal: new AbortController().signal, send: () => {} });
      assert.match(verified.answer, scenario.phrase);
      const statuses = db.prepare("SELECT status FROM verifications WHERE request_turn_id = ? ORDER BY status").all(index ? "demo-turn-postgres-question" : "demo-turn-november-3-question").map(({ status }) => status);
      assert.deepEqual(statuses, index ? ["confirmed_change", "confirmed_change", "not_comparable"] : ["unchanged", "unchanged", "unverified"], JSON.stringify(db.prepare("SELECT status, details_json FROM verifications WHERE request_turn_id = ? ORDER BY status").all(index ? "demo-turn-postgres-question" : "demo-turn-november-3-question")));
    }
  } finally { db.close(); }
});
