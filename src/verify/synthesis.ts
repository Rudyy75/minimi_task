import type { Verification } from "./diff.js";

export interface SynthesisInput {
  question: string;
  verdicts: Pick<Verification, "identityKey" | "status" | "confidence" | "materiality" | "reason" | "delta" | "twentySeatImpact" | "evidenceIds">[];
  evidence: { id: string; title: string; snippet: string }[];
  coverage: { inScope: number; fullyChecked: number; unverified: number; conflicting: number };
}

export function buildSynthesisInput(input: Omit<SynthesisInput, "coverage">): SynthesisInput {
  const evidenceIds = new Set(input.verdicts.flatMap(({ evidenceIds }) => evidenceIds));
  const fullyChecked = input.verdicts.filter(({ status }) => ["unchanged", "confirmed_change", "answer_needs_correction"].includes(status)).length;
  const conflicting = input.verdicts.filter(({ status }) => status === "conflicting_evidence").length;
  return {
    question: input.question,
    verdicts: input.verdicts.map(({ identityKey, status, confidence, materiality, reason, delta, twentySeatImpact, evidenceIds }) =>
      ({ identityKey, status, confidence, materiality, reason, delta, twentySeatImpact, evidenceIds })),
    evidence: input.evidence.filter(({ id }) => evidenceIds.has(id)).map(({ id, title, snippet }) => ({ id, title, snippet })),
    coverage: { inScope: input.verdicts.length, fullyChecked, unverified: input.verdicts.length - fullyChecked - conflicting, conflicting },
  };
}

export type Benchmark = "crm_shortlist" | "november_3" | "postgres_hosting";

export function renderAnswer(benchmark: Benchmark, verdicts: readonly Verification[], baselineRecorded: boolean, entityNames: Readonly<Record<string, string>> = {}): string {
  if (benchmark === "crm_shortlist" && !baselineRecorded) {
    return "I found current pricing, but the shortlist did not record a price baseline, so I can't say whether prices changed.";
  }
  if (!verdicts.length) return "I couldn't verify any claims from the available evidence.";
  const lines = verdicts.map((verdict) => {
    const entityId = verdict.identityKey.split(":")[0];
    const entity = entityNames[entityId] ?? entityId;
    const detail = verdict.status === "confirmed_change" && verdict.delta !== null
      ? ` (${verdict.delta}${verdict.twentySeatImpact ? ` per seat; ${verdict.twentySeatImpact} for 20 seats` : ""})`
      : verdict.status === "not_comparable" || verdict.status === "terms_changed" ? " (terms are not comparable)" : "";
    return `${entity}: ${verdict.status.replaceAll("_", " ")}${detail}.`;
  });
  const unverified = verdicts.filter(({ status }) => status === "unverified" || status === "conflicting_evidence" || status === "not_comparable" || status === "terms_changed").length;
  const changed = verdicts.filter(({ status }) => status === "confirmed_change" || status === "answer_needs_correction").length;
  const coverage = changed === 0
    ? `No confirmed changes in the evidence I could verify; ${unverified} comparison${unverified === 1 ? " remains" : "s remain"} unverified or incomparable.`
    : `${changed} change${changed === 1 ? "" : "s"} found; ${unverified} comparison${unverified === 1 ? " remains" : "s remain"} unverified.`;
  return [...lines, coverage].join(" ");
}
