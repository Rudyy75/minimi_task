import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResolvedAnchor } from "../time/resolve-anchor.js";

export function saveAnchor(db: Database.Database, requestTurnId: string, anchor: ResolvedAnchor): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO temporal_anchors
    (id, request_turn_id, raw_text, resolver_version, time_zone, start_utc,
     end_utc_exclusive, start_ms, end_ms_exclusive, policy, candidates_json, ambiguous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      requestTurnId,
      anchor.rawText,
      anchor.resolverVersion,
      anchor.timeZone,
      anchor.primary.startUtc,
      anchor.primary.endUtcExclusive,
      anchor.primary.startMs,
      anchor.primary.endMsExclusive,
      anchor.policy,
      JSON.stringify({ alternatives: anchor.alternatives, disclosure: anchor.disclosure, comparisonBoundary: anchor.comparisonBoundary }),
      Number(anchor.ambiguous),
    );
  return id;
}
