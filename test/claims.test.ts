import assert from "node:assert/strict";
import test from "node:test";
import { BACKFILL_DISCLOSURE, createBackfillClaim, validateClaim } from "../src/verify/claims.js";

const snippet = "AcmeCRM Basic costs $12.50 per seat per month.";
const candidate = {
  entityId: "acmecrm", predicate: "plan.price",
  value: { kind: "price", plan: "Basic", amountDecimal: "12.50", currency: "USD", basis: "seat", interval: "month", billing: "monthly", usageUnit: null, minimumSeats: null, region: null },
  observedAtUtc: "2026-11-17T12:00:00.000Z", effectiveAtUtc: null,
  extraction: { method: "model_validated", confidence: 0.8 },
  evidence: [{ evidenceId: "ev1", stance: "supports", quote: "AcmeCRM Basic costs $12.50", quoteStart: 0, quoteEnd: 26 }],
};

test("validated claims use decimal strings, normalize keys, and require exact stored quote spans", () => {
  const claim = validateClaim(candidate, [{ id: "ev1", snippet }]);
  assert.equal(claim.identityKey, "acmecrm:plan.price:basic:global");
  assert.equal(claim.comparabilityKey, "USD:seat:month:monthly:-:-");
  assert.deepEqual(claim.evidenceIds, ["ev1"]);
  assert.throws(() => validateClaim({ ...candidate, evidence: [{ ...candidate.evidence[0], evidenceId: "fake" }] }, [{ id: "ev1", snippet }]), /Unknown evidence ID/);
  assert.throws(() => validateClaim({ ...candidate, evidence: [{ ...candidate.evidence[0], quote: "AcmeCRM Basic costs $99.99" }] }, [{ id: "ev1", snippet }]), /Quote span/);
  assert.throws(() => validateClaim({ ...candidate, value: { ...candidate.value, amountDecimal: 12.5 } }, [{ id: "ev1", snippet }]));
  assert.throws(() => validateClaim({ ...candidate, value: { ...candidate.value, currency: "ZZZ" } }, [{ id: "ev1", snippet }]));
});

test("prose-reconstructed claims are marked backfill and carry an explicit disclosure", () => {
  const claim = createBackfillClaim({
    entityId: "acmecrm", predicate: "plan.price",
    value: { kind: "price", plan: "Basic", amountDecimal: "12.50", currency: "USD", basis: "seat", interval: "month", billing: "monthly", usageUnit: null, minimumSeats: null, region: null },
    observedAtUtc: "2026-11-17T12:00:00.000Z", effectiveAtUtc: null,
  });
  assert.equal(claim.extraction.method, "backfill");
  assert.deepEqual(claim.evidenceIds, []);
  assert.match(BACKFILL_DISCLOSURE, /reconstructed/);
});
