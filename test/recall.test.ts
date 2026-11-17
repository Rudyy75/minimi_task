import assert from "node:assert/strict";
import test from "node:test";
import { saveAnchor } from "../src/memory/anchor-repository.js";
import { openDatabase } from "../src/memory/db.js";
import { recallByInterval } from "../src/memory/recall.js";
import { seedDemo } from "../src/memory/seed-demo.js";
import { resolveAnchor } from "../src/time/resolve-anchor.js";

test("demo seeding is idempotent and date recall returns the exact November 3 question", () => {
  const db = openDatabase(":memory:");
  try {
    const clock = { now: () => new Date("2026-11-17T18:00:00Z") };
    seedDemo(db, clock, "UTC");
    seedDemo(db, clock, "UTC");

    const anchor = resolveAnchor("What did I ask on November 3?", clock.now(), "UTC");
    const secondQuestionTime = anchor!.primary.startMs + 12 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO turns
      (id, conversation_id, seq, role, content, created_at_utc, created_at_ms, time_zone, local_date, status, content_sha256)
      VALUES ('second-question', 'demo-conversation', 7, 'user', 'What was the second option?', ?, ?, 'UTC', '2026-11-03', 'committed', 'fixture')`)
      .run(new Date(secondQuestionTime).toISOString(), secondQuestionTime);
    db.prepare("INSERT INTO turn_fts (turn_id, content) VALUES ('second-question', 'What was the second option?')").run();
    const recalled = recallByInterval(db, "demo-conversation", anchor!.primary, "What did I ask?");
    assert.deepEqual(recalled.turns.map((turn) => turn.content), [
      "Can AcmeCRM and BrightDesk both export audit logs, and which is cheaper for a five-person team?",
      "What was the second option?",
    ]);
    assert.equal(recalled.episodes.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM turns").get().count, 7);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claims").get().count, 6);
    const storedAnchor = resolveAnchor("What did I ask on November 3?", clock.now(), "America/Los_Angeles");
    const anchorId = saveAnchor(db, "demo-turn-november-3-question", storedAnchor!);
    const stored = db.prepare("SELECT resolver_version, time_zone FROM temporal_anchors WHERE id = ?").get(anchorId);
    assert.deepEqual(stored, { resolver_version: "1", time_zone: "America/Los_Angeles" });
  } finally {
    db.close();
  }
});

test("shortlist entities retain their order and enforce the stated cardinality", () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, { now: () => new Date("2026-11-17T18:00:00Z") }, "UTC");
    const anchor = resolveAnchor("What was on the CRM shortlist Monday?", "2026-11-17T18:00:00Z", "UTC");
    const recalled = recallByInterval(db, "demo-conversation", anchor!.primary, "CRM shortlist");
    assert.deepEqual(recalled.episodes[0]?.entities.map((entity) => entity.display_name), [
      "AcmeCRM", "BrightDesk", "CopperLeaf", "DeskNest", "Everflow",
    ]);
    const textRecall = recallByInterval(db, "demo-conversation", anchor!.primary, "We shortlisted these five CRMs");
    assert.equal(textRecall.episodes[0]?.id, "demo-episode-crm");
    const entityRecall = recallByInterval(db, "demo-conversation", anchor!.primary, "Copper");
    assert.equal(entityRecall.episodes[0]?.id, "demo-episode-crm");
  } finally {
    db.close();
  }
});

test("flat cosine ranks eligible episodes only after lexical and entity recall fail", () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db, { now: () => new Date("2026-11-17T18:00:00Z") }, "UTC");
    const interval = resolveAnchor("Monday", "2026-11-17T18:00:00Z", "UTC")!.primary;
    const competitorAt = interval.startMs + 12 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO episodes
      (id, conversation_id, kind, title, opened_turn_id, occurred_at_utc, occurred_at_ms, payload_json)
      VALUES ('semantic-episode', 'demo-conversation', 'question', 'Semantic match', 'demo-turn-crm-question', ?, ?, '{}')`)
      .run(new Date(competitorAt).toISOString(), competitorAt);
    const insertVector = db.prepare(`INSERT INTO embeddings
      (owner_type, owner_id, model, dimensions, vector_blob, content_sha256) VALUES ('episode', ?, 'test', 2, ?, 'fixture')`);
    insertVector.run("demo-episode-crm", Buffer.from(Float32Array.of(1, 0).buffer));
    insertVector.run("semantic-episode", Buffer.from(Float32Array.of(0, 1).buffer));
    const recalled = recallByInterval(db, "demo-conversation", interval, "unmatchedTerm", { model: "test", values: Float32Array.of(0, 1) });
    assert.equal(recalled.episodes[0]?.id, "semantic-episode");
  } finally {
    db.close();
  }
});
