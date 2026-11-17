import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../time/clock.js";
import { intervalForLocalDate, resolveAnchor } from "../time/resolve-anchor.js";

const crmNames = ["AcmeCRM", "BrightDesk", "CopperLeaf", "DeskNest", "Everflow"];
const postgresNames = ["NeonDB", "RiverPostgres", "CloudBase"];
const demoClaims = {
  crm: [{ entity: "AcmeCRM", predicate: "plan.price", value: { type: "price", amount: "18.00", currency: "USD", basis: "per_user", interval: "month", plan: "Basic" }, identity: "acmecrm:basic:price", comparable: "USD:per_user:month" }],
  november: [
    { entity: "AcmeCRM", predicate: "feature.audit_logs", value: { type: "feature_state", state: "available", plan: "Standard" }, identity: "acmecrm:standard:audit_logs", comparable: "feature_state" },
    { entity: "BrightDesk", predicate: "plan.price", value: { type: "price", amount: "12.00", currency: "USD", basis: "per_user", interval: "month", plan: "Standard" }, identity: "brightdesk:standard:price", comparable: "USD:per_user:month" },
  ],
  postgres: [
    { entity: "NeonDB", predicate: "plan.price", value: { type: "price", amount: "19.00", currency: "USD", basis: "instance", interval: "month", plan: "Launch" }, identity: "neondb:launch:price", comparable: "USD:instance:month" },
    { entity: "RiverPostgres", predicate: "plan.price", value: { type: "price", amount: "120.00", currency: "USD", basis: "instance", interval: "year", plan: "Starter" }, identity: "riverpostgres:starter:price", comparable: "USD:instance:year" },
    { entity: "CloudBase", predicate: "plan.price", value: { type: "price", amount: "16.00", currency: "USD", basis: "instance", interval: "month", plan: "Entry" }, identity: "cloudbase:entry:price", comparable: "USD:instance:month" },
  ],
};

export function seedDemo(db: Database.Database, clock: Clock, timeZone: string): boolean {
  const now = clock.now();
  const monday = resolveAnchor("Monday", now, timeZone)!.primary.localStart;
  const lastTuesday = resolveAnchor("last Tuesday", now, timeZone)!.primary.localStart;
  const november3 = resolveAnchor("3 November", now, timeZone)!.primary.localStart;
  const events = [
    {
      key: "crm", date: monday, kind: "shortlist", title: "CRM shortlist", names: crmNames, entityKind: "crm",
      question: `We shortlisted these five CRMs on Monday: ${crmNames.join(", ")}. Please remember the list.`,
      answer: "Saved the five products in the order discussed. The deliberately stale AcmeCRM Basic price baseline is $18 per user per month (synthetic demo data).", payload: { expectedEntityCount: 5 }, claims: demoClaims.crm,
    },
    {
      key: "november-3", date: november3, kind: "question", title: "November 3 comparison", names: ["AcmeCRM", "BrightDesk"], entityKind: "crm",
      question: "Can AcmeCRM and BrightDesk both export audit logs, and which is cheaper for a five-person team?",
      answer: "AcmeCRM supports audit logs; BrightDesk costs $12 per user per month.", payload: {}, claims: demoClaims.november,
    },
    {
      key: "postgres", date: lastTuesday, kind: "comparison", title: "Postgres hosting comparison", names: postgresNames, entityKind: "postgres_host",
      question: `Last Tuesday we compared Postgres hosting from ${postgresNames.join(", ")} for a small app.`,
      answer: "The comparison included monthly and annual plans; those terms need to stay separate.", payload: {}, claims: demoClaims.postgres,
    },
  ];

  return db.transaction(() => {
    if ((db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count) return false;

    const conversationId = "demo-conversation";
    db.prepare("INSERT INTO conversations (id, user_id, created_at_utc) VALUES (?, ?, ?)")
      .run(conversationId, "local-demo", now.toISOString());
    const addTurn = db.prepare(`INSERT INTO turns
      (id, conversation_id, seq, client_message_id, role, content, created_at_utc, created_at_ms,
       completed_at_ms, time_zone, local_date, status, run_id, model, content_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, NULL, ?)`);
    const addFts = db.prepare("INSERT INTO turn_fts (turn_id, content) VALUES (?, ?)");
    const addEpisode = db.prepare(`INSERT INTO episodes
      (id, conversation_id, kind, title, opened_turn_id, answer_turn_id, occurred_at_utc, occurred_at_ms, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addEpisodeTurn = db.prepare("INSERT INTO episode_turns (episode_id, turn_id, relation) VALUES (?, ?, ?)");
    const addEntity = db.prepare(`INSERT INTO entities
      (id, kind, canonical_name, display_name, aliases_json, official_domains_json, metadata_json)
      VALUES (?, ?, ?, ?, '[]', '[]', '{}') ON CONFLICT(kind, canonical_name) DO NOTHING`);
    const addEpisodeEntity = db.prepare("INSERT INTO episode_entities (episode_id, entity_id, ordinal, role) VALUES (?, ?, ?, ?)");
    const addSnapshot = db.prepare(`INSERT INTO snapshots
      (id, episode_id, answer_turn_id, captured_at_utc, captured_at_ms, schema_version, answer_sha256)
      VALUES (?, ?, ?, ?, ?, '1', ?)`);
    const addClaim = db.prepare(`INSERT INTO claims
      (id, snapshot_id, entity_id, predicate, value_json, identity_key, comparability_key, observed_at_utc,
       observed_at_ms, effective_at_utc, effective_precision, extraction_method, extraction_confidence,
       normalization_version, claim_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'backfill', 0.5, '1', ?)`);
    let seq = 0;

    for (const event of events) {
      const interval = intervalForLocalDate(event.date, timeZone);
      const occurredAtMs = interval.startMs + 10 * 60 * 60 * 1000;
      const occurredAt = new Date(occurredAtMs).toISOString();
      const eventId = `demo-episode-${event.key}`;
      const userTurnId = `demo-turn-${event.key}-question`;
      const answerTurnId = `demo-turn-${event.key}-answer`;
      addTurn.run(userTurnId, conversationId, ++seq, `demo-${event.key}-question`, "user", event.question, occurredAt,
        occurredAtMs, null, timeZone, event.date, "demo-run", createHash("sha256").update(event.question).digest("hex"));
      addTurn.run(answerTurnId, conversationId, ++seq, `demo-${event.key}-answer`, "assistant", event.answer, occurredAt,
        occurredAtMs, occurredAtMs, timeZone, event.date, "demo-run", createHash("sha256").update(event.answer).digest("hex"));
      addFts.run(userTurnId, event.question);
      addFts.run(answerTurnId, event.answer);
      addEpisode.run(eventId, conversationId, event.kind, event.title, userTurnId, answerTurnId, occurredAt, occurredAtMs, JSON.stringify(event.payload));
      addEpisodeTurn.run(eventId, userTurnId, "question");
      addEpisodeTurn.run(eventId, answerTurnId, "answer");
      const snapshotId = `demo-snapshot-${event.key}`;
      addSnapshot.run(snapshotId, eventId, answerTurnId, occurredAt, occurredAtMs, createHash("sha256").update(event.answer).digest("hex"));

      event.names.forEach((name, index) => {
        const entityId = `demo-entity-${event.entityKind}-${name.toLowerCase()}`;
        addEntity.run(entityId, event.entityKind, name.toLowerCase(), name);
        addEpisodeEntity.run(eventId, entityId, index, event.key === "crm" ? "shortlisted" : "compared");
      });
      for (const [index, claim] of event.claims.entries()) {
        const entityId = `demo-entity-${event.entityKind}-${claim.entity.toLowerCase()}`;
        const valueJson = JSON.stringify(claim.value);
        addClaim.run(`demo-claim-${event.key}-${index}`, snapshotId, entityId, claim.predicate, valueJson,
          claim.identity, claim.comparable, occurredAt, occurredAtMs,
          createHash("sha256").update(valueJson).digest("hex"));
      }
    }
    return true;
  }).immediate();
}
