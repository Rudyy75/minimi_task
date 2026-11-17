import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected a non-negative decimal string");
const currencies = new Set(Intl.supportedValuesOf("currency"));
const currency = z.string().length(3).regex(/^[A-Z]{3}$/).refine((code) => currencies.has(code), "Unsupported ISO currency");
const priceValue = z.object({
  kind: z.literal("price"), plan: z.string().min(1), amountDecimal: decimal, currency,
  basis: z.enum(["seat", "account", "usage"]), interval: z.enum(["month", "year", "one_off"]),
  billing: z.enum(["monthly", "annual", "unknown"]), usageUnit: z.string().nullable(), minimumSeats: z.number().int().nonnegative().nullable(), region: z.string().nullable(),
}).strict();
const featureValue = z.object({
  kind: z.literal("feature_state"), feature: z.string().min(1), state: z.enum(["announced", "beta", "ga", "deprecated", "removed"]), planScope: z.array(z.string()),
}).strict();
const limitValue = z.object({
  kind: z.literal("plan_limit"), plan: z.string().min(1), limitName: z.string().min(1), valueDecimal: decimal, unit: z.string().min(1),
}).strict();
export const claimValueSchema = z.discriminatedUnion("kind", [priceValue, featureValue, limitValue]);
export type ClaimValue = z.infer<typeof claimValueSchema>;

const isoUtc = z.string().refine((value) => value.endsWith("Z") && Number.isFinite(Date.parse(value)), "Expected an ISO UTC timestamp");
const candidateSchema = z.object({
  entityId: z.string().nullable(),
  predicate: z.enum(["plan.price", "feature.state", "plan.limit"]),
  value: claimValueSchema,
  observedAtUtc: isoUtc,
  effectiveAtUtc: isoUtc.nullable(),
  extraction: z.object({ method: z.enum(["deterministic", "model_validated", "backfill"]), confidence: z.number().min(0).max(1) }).strict(),
  evidence: z.array(z.object({ evidenceId: z.string().min(1), stance: z.enum(["supports", "contradicts"]), quote: z.string().min(1), quoteStart: z.number().int().nonnegative(), quoteEnd: z.number().int().positive() }).strict()),
}).strict().superRefine((candidate, context) => {
  const expectedKind = { "plan.price": "price", "feature.state": "feature_state", "plan.limit": "plan_limit" }[candidate.predicate];
  if (candidate.value.kind !== expectedKind) context.addIssue({ code: "custom", message: "Predicate and claim value kind do not match", path: ["value", "kind"] });
  if (candidate.extraction.method !== "backfill" && candidate.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "Source-backed claims require evidence", path: ["evidence"] });
  }
});

export interface EvidenceExcerpt { id: string; snippet: string }
export interface Claim {
  id: string;
  entityId: string | null;
  predicate: "plan.price" | "feature.state" | "plan.limit";
  value: ClaimValue;
  observedAtUtc: string;
  effectiveAtUtc: string | null;
  identityKey: string;
  comparabilityKey: string;
  evidenceIds: string[];
  evidence: { evidenceId: string; stance: "supports" | "contradicts"; quote: string; quoteStart: number; quoteEnd: number }[];
  extraction: { method: "deterministic" | "model_validated" | "backfill"; confidence: number; disclosure: string | null };
  claimHash: string;
}

function keys(entityId: string | null, predicate: Claim["predicate"], value: ClaimValue): { identityKey: string; comparabilityKey: string } {
  const entity = entityId ?? "unknown";
  const normalize = (part: string) => part.trim().toLowerCase();
  if (value.kind === "price") return {
    identityKey: `${entity}:${predicate}:${normalize(value.plan)}:${normalize(value.region ?? "global")}`,
    comparabilityKey: `${value.currency}:${value.basis}:${value.interval}:${value.billing}:${value.usageUnit ? normalize(value.usageUnit) : "-"}:${value.minimumSeats ?? "-"}`,
  };
  if (value.kind === "feature_state") return {
    identityKey: `${entity}:${predicate}:${normalize(value.feature)}:${value.planScope.map(normalize).sort().join(",")}`,
    comparabilityKey: `feature_state:${value.planScope.map(normalize).sort().join(",")}`,
  };
  return { identityKey: `${entity}:${predicate}:${normalize(value.plan)}:${normalize(value.limitName)}`, comparabilityKey: `limit:${normalize(value.unit)}` };
}

export function validateClaim(input: unknown, evidence: readonly EvidenceExcerpt[]): Claim {
  const candidate = candidateSchema.parse(input);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const reference of candidate.evidence) {
    const source = evidenceById.get(reference.evidenceId);
    if (!source) throw new Error(`Unknown evidence ID: ${reference.evidenceId}`);
    if (reference.quoteEnd > source.snippet.length || source.snippet.slice(reference.quoteStart, reference.quoteEnd) !== reference.quote) {
      throw new Error(`Quote span does not match evidence ${reference.evidenceId}`);
    }
  }
  const { identityKey, comparabilityKey } = keys(candidate.entityId, candidate.predicate, candidate.value);
  const claim = {
    id: randomUUID(), entityId: candidate.entityId, predicate: candidate.predicate, value: candidate.value,
    observedAtUtc: candidate.observedAtUtc, effectiveAtUtc: candidate.effectiveAtUtc, identityKey, comparabilityKey,
    evidenceIds: [...new Set(candidate.evidence.map(({ evidenceId }) => evidenceId))], evidence: candidate.evidence,
    extraction: { ...candidate.extraction, disclosure: candidate.extraction.method === "backfill" ? BACKFILL_DISCLOSURE : null },
  };
  return { ...claim, claimHash: createHash("sha256").update(JSON.stringify(claim)).digest("hex") };
}

export function createBackfillClaim(input: Omit<Parameters<typeof validateClaim>[0], "evidence" | "extraction"> & { extraction?: never }): Claim {
  return validateClaim({ ...input, extraction: { method: "backfill", confidence: 0.35 }, evidence: [] }, []);
}

export const BACKFILL_DISCLOSURE = "This claim was reconstructed from an earlier answer; a precise source-backed baseline was not preserved.";
