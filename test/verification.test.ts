import assert from "node:assert/strict";
import test from "node:test";
import { compareClaims, type Verification } from "../src/verify/diff.js";
import { gateCitations } from "../src/verify/citation-gate.js";
import { buildSynthesisInput, renderAnswer } from "../src/verify/synthesis.js";
import { validateClaim, type Claim } from "../src/verify/claims.js";

function price(amount: string, options: { billing?: "monthly" | "annual" | "unknown"; basis?: "seat" | "account" | "usage"; currency?: string } = {}): Claim {
  const snippet = `AcmeCRM Basic costs ${options.currency ?? "USD"} ${amount} per seat per month.`;
  const evidence = [{ id: "ev-current", snippet }];
  return validateClaim({
    entityId: "acme", predicate: "plan.price",
    value: { kind: "price", plan: "Basic", amountDecimal: amount, currency: options.currency ?? "USD", basis: options.basis ?? "seat", interval: options.billing === "annual" ? "year" : "month", billing: options.billing ?? "monthly", usageUnit: null, minimumSeats: null, region: null },
    observedAtUtc: "2026-11-17T12:00:00Z", effectiveAtUtc: null,
    extraction: { method: "model_validated", confidence: 0.9 },
    evidence: [{ evidenceId: "ev-current", stance: "supports", quote: snippet, quoteStart: 0, quoteEnd: snippet.length }],
  }, evidence);
}

test("diff gates comparability, suppresses immaterial price changes, and computes 20-seat delta", () => {
  const before = price("18.00");
  const after = price("20.00");
  const changed = compareClaims(before, after);
  assert.equal(changed.status, "confirmed_change");
  assert.equal(changed.materiality, "material");
  assert.equal(changed.twentySeatImpact, "40.00");
  assert.equal(compareClaims(before, price("18.50")).status, "unchanged");
  assert.equal(compareClaims(before, price("18.50", { billing: "annual" })).status, "not_comparable");
  assert.equal(compareClaims(before, price("18.50", { currency: "EUR" })).status, "terms_changed");
  assert.equal(compareClaims(before, null).status, "unverified");
});

test("contradictory evidence is surfaced and confidence uses the weakest input", () => {
  const claim = price("20.00");
  const conflicting = { ...claim, evidence: [...claim.evidence, { ...claim.evidence[0], stance: "contradicts" as const }] };
  assert.equal(compareClaims(price("18.00"), conflicting).status, "conflicting_evidence");
  const low = { ...claim, extraction: { ...claim.extraction, confidence: 0.4 } };
  assert.equal(compareClaims(price("18.00"), low).confidence, "low");
});

test("citation gate rejects unknown and unsupported IDs, strips model URLs, and links trusted sources", () => {
  const current = price("20.00");
  const verdict: Verification = compareClaims(price("18.00"), current);
  const sources = [{ id: "ev-current", url: "https://vendor.example/pricing", title: "Pricing", supportsClaimIds: [current.id] }];
  assert.equal(gateCitations("Now $20 [[ev-current]] https://fake.example", [verdict], sources), "Now $20 [Pricing](https://vendor.example/pricing)");
  assert.throws(() => gateCitations("[[fake]]", [verdict], sources), /Unknown citation/);
  assert.throws(() => gateCitations("[[ev-current]]", [], sources), /does not support/);
  assert.throws(() => gateCitations("[[ev-other]]", [verdict], [{ id: "ev-other", url: "https://vendor.example/other", title: "Other", supportsClaimIds: [current.id] }]), /does not support/);
  assert.equal(gateCitations("[[ev-current]]", [verdict], [{ ...sources[0], title: "Pricing](https://evil.example", url: "https://vendor.example/a(b)" }]), "[Pricing\\](https://evil.example](https://vendor.example/a%28b%29)");
});

test("synthesis sees compact verdicts and benchmark answers disclose absent or incomparable baselines", () => {
  const verification = compareClaims(price("18.00"), price("20.00"));
  const input = buildSynthesisInput({ question: "Compare prices", verdicts: [verification], evidence: [{ id: "ev-current", title: "Pricing", snippet: "AcmeCRM Basic costs USD 20.00 per seat per month." }, { id: "unused", title: "Raw history", snippet: "excluded" }] });
  assert.deepEqual(input.evidence.map(({ id }) => id), ["ev-current"]);
  assert.deepEqual(Object.keys(input).sort(), ["coverage", "evidence", "question", "verdicts"]);
  assert.deepEqual(input.coverage, { inScope: 1, fullyChecked: 1, unverified: 0, conflicting: 0 });
  assert.equal(renderAnswer("crm_shortlist", [verification], false), "I found current pricing, but the shortlist did not record a price baseline, so I can't say whether prices changed.");
  assert.match(renderAnswer("november_3", [verification], true, { acme: "AcmeCRM" }), /AcmeCRM: confirmed change/);
  const annual = compareClaims(price("18.00"), price("120.00", { billing: "annual" }));
  assert.match(renderAnswer("postgres_hosting", [annual], true), /not comparable/);
});
