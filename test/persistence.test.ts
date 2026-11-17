import assert from "node:assert/strict";
import test from "node:test";
import { createRequestContext } from "../src/app/context.js";
import { openDatabase } from "../src/memory/db.js";
import { seedDemo } from "../src/memory/seed-demo.js";
import { saveSnapshot } from "../src/memory/snapshot-repository.js";
import { captureLiveEpisode, saveUserTurn } from "../src/memory/turn-repository.js";
import { createBackfillClaim } from "../src/verify/claims.js";

test("live event dates resolve against the message timestamp and capture idempotently", () => {
  const db = openDatabase(":memory:");
  try {
    const context = createRequestContext({ now: () => new Date("2026-11-17T12:00:00Z") }, { conversationId: "live-conversation", timeZone: "UTC", locale: "en-US" });
    const turn = saveUserTurn(db, context, { userId: "local", runId: "run", clientMessageId: "msg-1", content: "On Monday we shortlisted AcmeCRM and BrightDesk." });
    const retried = saveUserTurn(db, context, { userId: "local", runId: "retry", clientMessageId: "msg-1", content: turn.content });
    const captured = captureLiveEpisode(db, turn)!;
    const repeated = captureLiveEpisode(db, turn)!;
    assert.equal(captured.anchor.primary.localStart, "2026-11-16");
    assert.equal(retried.id, turn.id);
    assert.throws(() => saveUserTurn(db, context, { userId: "local", runId: "retry", clientMessageId: "msg-1", content: "different" }), /different message/);
    assert.equal(repeated.episodeId, captured.episodeId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM episodes WHERE opened_turn_id = ?").get(turn.id).count, 1);
  } finally {
    db.close();
  }
});

test("completed answer snapshots append immutable claims and keep backfill provenance", () => {
  const db = openDatabase(":memory:");
  try {
    const clock = { now: () => new Date("2026-11-17T18:00:00Z") };
    seedDemo(db, clock, "UTC");
    const claim = () => createBackfillClaim({
      entityId: "demo-entity-crm-acmecrm", predicate: "plan.price",
      value: { kind: "price", plan: "Basic", amountDecimal: "18.00", currency: "USD", basis: "seat", interval: "month", billing: "monthly", usageUnit: null, minimumSeats: null, region: null },
      observedAtUtc: "2026-11-16T10:00:00.000Z", effectiveAtUtc: null,
    });
    const input = { episodeId: "demo-episode-crm", answerTurnId: "demo-turn-crm-answer", answer: "saved answer", capturedAtUtc: "2026-11-17T18:00:00Z" };
    const first = saveSnapshot(db, { ...input, claims: [claim()] });
    saveSnapshot(db, { ...input, capturedAtUtc: "2026-11-18T18:00:00Z", claims: [claim()] });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE answer_turn_id = ?").get(input.answerTurnId).count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE snapshot_id = ? AND extraction_method = 'backfill'").get(first).count, 1);
    assert.throws(() => db.prepare("UPDATE snapshots SET schema_version = '2' WHERE id = ?").run(first), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM snapshots WHERE id = ?").run(first), /immutable/);
  } finally {
    db.close();
  }
});
