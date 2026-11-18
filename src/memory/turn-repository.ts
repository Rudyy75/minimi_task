import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequestContext } from "../app/context.js";
import { localDateAt, resolveAnchor, type ResolvedAnchor } from "../time/resolve-anchor.js";
import { saveAnchor } from "./anchor-repository.js";
import { saveSnapshot } from "./snapshot-repository.js";
import type { Claim } from "../verify/claims.js";

export interface SavedTurn {
  id: string;
  conversationId: string;
  content: string;
  createdAtUtc: string;
  createdAtMs: number;
  timeZone: string;
}

export function saveAssistantAnswer(db: Database.Database, context: RequestContext, input: { requestTurnId: string; runId: string; content: string; episodeId?: string | null; claims?: readonly Claim[] }): string {
  const id = randomUUID();
  const digest = createHash("sha256").update(input.content).digest("hex");
  db.transaction(() => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = (SELECT conversation_id FROM turns WHERE id = ?)").get(input.requestTurnId) as { seq: number }).seq;
    db.prepare(`INSERT INTO turns (id, conversation_id, seq, role, content, created_at_utc, created_at_ms, completed_at_ms, time_zone, local_date, status, run_id, content_sha256)
      SELECT ?, conversation_id, ?, 'assistant', ?, ?, ?, ?, ?, ?, 'committed', ?, ? FROM turns WHERE id = ?`)
      .run(id, seq, input.content, context.nowUtc, context.nowMs, context.nowMs, context.timeZone, localDateAt(context.nowMs, context.timeZone), input.runId, digest, input.requestTurnId);
    db.prepare("INSERT INTO turn_fts (turn_id, content) VALUES (?, ?)").run(id, input.content);
    if (input.episodeId) db.prepare("INSERT INTO episode_turns (episode_id, turn_id, relation) VALUES (?, ?, 'answer')").run(input.episodeId, id);
    saveSnapshot(db, { episodeId: input.episodeId, answerTurnId: id, answer: input.content, capturedAtUtc: context.nowUtc, claims: input.claims ?? [] });
  }).immediate();
  return id;
}

export function markTurnPartial(db: Database.Database, turnId: string): void {
  db.prepare("UPDATE turns SET status = 'partial' WHERE id = ? AND status = 'committed'").run(turnId);
}

export function saveUserTurn(db: Database.Database, context: RequestContext, input: { userId: string; content: string; clientMessageId?: string; runId: string }): SavedTurn {
  const turnId = randomUUID();
  const digest = createHash("sha256").update(input.content).digest("hex");
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO conversations (id, user_id, created_at_utc) VALUES (?, ?, ?)")
      .run(context.conversationId, input.userId, context.nowUtc);
    if (input.clientMessageId) {
      const prior = db.prepare(`SELECT id, conversation_id, content, created_at_utc, created_at_ms, time_zone
        FROM turns WHERE conversation_id = ? AND client_message_id = ?`).get(context.conversationId, input.clientMessageId) as {
          id: string; conversation_id: string; content: string; created_at_utc: string; created_at_ms: number; time_zone: string;
        } | undefined;
      if (prior) {
        if (prior.content !== input.content) throw new Error("client_message_id was already used for a different message");
        return { id: prior.id, conversationId: prior.conversation_id, content: prior.content, createdAtUtc: prior.created_at_utc, createdAtMs: prior.created_at_ms, timeZone: prior.time_zone };
      }
    }
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE conversation_id = ?").get(context.conversationId) as { seq: number }).seq;
    db.prepare(`INSERT INTO turns
      (id, conversation_id, seq, client_message_id, role, content, created_at_utc, created_at_ms,
       time_zone, local_date, status, run_id, content_sha256)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, 'committed', ?, ?)`)
      .run(turnId, context.conversationId, seq, input.clientMessageId ?? null, input.content, context.nowUtc, context.nowMs,
        context.timeZone, localDateAt(context.nowMs, context.timeZone), input.runId, digest);
    db.prepare("INSERT INTO turn_fts (turn_id, content) VALUES (?, ?)").run(turnId, input.content);
    return { id: turnId, conversationId: context.conversationId, content: input.content, createdAtUtc: context.nowUtc, createdAtMs: context.nowMs, timeZone: context.timeZone };
  }).immediate();
}

export function captureLiveEpisode(db: Database.Database, turn: SavedTurn): { episodeId: string; anchor: ResolvedAnchor } | null {
  const kind = /\b(shortlist|shortlisted|shortlisting)\b/i.test(turn.content)
    ? "shortlist"
    : /\b(compare|compared|comparing|comparison)\b/i.test(turn.content) ? "comparison" : null;
  if (!kind) return null;
  const anchor = resolveAnchor(turn.content, turn.createdAtUtc, turn.timeZone);
  if (!anchor) return null;
  const episodeId = randomUUID();
  return db.transaction(() => {
    const prior = db.prepare("SELECT id FROM episodes WHERE opened_turn_id = ?").get(turn.id) as { id: string } | undefined;
    if (prior) return { episodeId: prior.id, anchor };
    const occurredAtMs = anchor.primary.startMs;
    db.prepare(`INSERT INTO episodes
      (id, conversation_id, kind, title, opened_turn_id, occurred_at_utc, occurred_at_ms, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(episodeId, turn.conversationId, kind, `${kind} · ${anchor.primary.localStart}`, turn.id,
        anchor.primary.startUtc, occurredAtMs, JSON.stringify({ eventLocalDate: anchor.primary.localStart, messageTimestampUtc: turn.createdAtUtc, timeZone: turn.timeZone, resolverVersion: anchor.resolverVersion }));
    db.prepare("INSERT INTO episode_turns (episode_id, turn_id, relation) VALUES (?, ?, 'question')").run(episodeId, turn.id);
    saveAnchor(db, turn.id, anchor);
    return { episodeId, anchor };
  }).immediate();
}
