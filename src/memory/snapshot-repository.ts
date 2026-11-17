import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Claim } from "../verify/claims.js";

export function saveSnapshot(db: Database.Database, input: {
  episodeId?: string | null;
  answerTurnId: string;
  answer: string;
  capturedAtUtc: string;
  claims: readonly Claim[];
}): string {
  const snapshotId = randomUUID();
  const capturedAtMs = Date.parse(input.capturedAtUtc);
  if (!Number.isFinite(capturedAtMs)) throw new TypeError("capturedAtUtc must be a valid timestamp");
  db.transaction(() => {
    db.prepare(`INSERT INTO snapshots
      (id, episode_id, answer_turn_id, captured_at_utc, captured_at_ms, schema_version, answer_sha256)
      VALUES (?, ?, ?, ?, ?, '1', ?)`)
      .run(snapshotId, input.episodeId ?? null, input.answerTurnId, input.capturedAtUtc, capturedAtMs,
        createHash("sha256").update(input.answer).digest("hex"));
    const addClaim = db.prepare(`INSERT INTO claims
      (id, snapshot_id, entity_id, predicate, value_json, identity_key, comparability_key, observed_at_utc,
       observed_at_ms, effective_at_utc, effective_precision, extraction_method, extraction_confidence,
       normalization_version, claim_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '1', ?)`);
    const addEvidence = db.prepare(`INSERT INTO claim_evidence
      (claim_id, evidence_id, stance, quote, quote_start, quote_end) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const claim of input.claims) {
      const observedAtMs = Date.parse(claim.observedAtUtc);
      if (!Number.isFinite(observedAtMs)) throw new TypeError("Claim observedAtUtc must be a valid timestamp");
      addClaim.run(claim.id, snapshotId, claim.entityId, claim.predicate, JSON.stringify(claim.value), claim.identityKey,
        claim.comparabilityKey, claim.observedAtUtc, observedAtMs, claim.effectiveAtUtc, claim.extraction.method,
        claim.extraction.confidence, claim.claimHash);
      for (const link of claim.evidence) {
        addEvidence.run(claim.id, link.evidenceId, link.stance, link.quote, link.quoteStart, link.quoteEnd);
      }
    }
  }).immediate();
  return snapshotId;
}
