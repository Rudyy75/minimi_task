import type { Claim, ClaimValue } from "./claims.js";

export type VerificationStatus = "unchanged" | "confirmed_change" | "answer_needs_correction" | "terms_changed" | "conflicting_evidence" | "not_comparable" | "unverified";
export interface Verification {
  identityKey: string;
  baselineClaimId: string | null;
  currentClaimId: string | null;
  status: VerificationStatus;
  confidence: "high" | "medium" | "low";
  materiality: "material" | "cosmetic" | "unknown";
  reason: string;
  delta: string | null;
  twentySeatImpact: string | null;
  evidenceIds: string[];
}

function decimalParts(value: string): [bigint, number] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), fraction.length];
}

function decimalDelta(before: string, after: string): string {
  const [a, scaleA] = decimalParts(before);
  const [b, scaleB] = decimalParts(after);
  const scale = Math.max(scaleA, scaleB);
  const delta = b * 10n ** BigInt(scale - scaleB) - a * 10n ** BigInt(scale - scaleA);
  const negative = delta < 0n;
  const digits = (negative ? -delta : delta).toString().padStart(scale + 1, "0");
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return `${negative ? "-" : ""}${result}`;
}

function multiplyDecimal(value: string, multiplier: number): string {
  const [integer, scale] = decimalParts(value);
  const product = integer * BigInt(multiplier);
  const negative = product < 0n;
  const digits = (negative ? -product : product).toString().padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

function confidence(claims: (Claim | null)[]): Verification["confidence"] {
  const values = claims.filter((claim): claim is Claim => claim !== null).map((claim) => claim.extraction.confidence);
  if (!values.length) return "low";
  const value = Math.min(...values);
  return value >= 0.8 ? "high" : value >= 0.5 ? "medium" : "low";
}

function equalValue(a: ClaimValue, b: ClaimValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "price" && b.kind === "price") return decimalDelta(a.amountDecimal, b.amountDecimal) === "0";
  return JSON.stringify(a) === JSON.stringify(b);
}

function lessThanOne(value: string): boolean {
  const [amount, scale] = decimalParts(value.startsWith("-") ? value.slice(1) : value);
  return amount < 10n ** BigInt(scale);
}

function result(baseline: Claim | null, current: Claim | null, status: VerificationStatus, reason: string,
  options: Partial<Pick<Verification, "materiality" | "delta" | "twentySeatImpact">> = {}): Verification {
  return {
    identityKey: current?.identityKey ?? baseline?.identityKey ?? "unknown",
    baselineClaimId: baseline?.id ?? null, currentClaimId: current?.id ?? null, status,
    confidence: confidence([baseline, current]), materiality: options.materiality ?? "unknown", reason,
    delta: options.delta ?? null, twentySeatImpact: options.twentySeatImpact ?? null,
    evidenceIds: [...new Set(current?.evidenceIds ?? [])],
  };
}

export function compareClaims(baseline: Claim | null, current: Claim | null): Verification {
  if (!baseline || !current) return result(baseline, current, "unverified", "A source-backed baseline or current claim is missing.");
  if (baseline.identityKey !== current.identityKey) return result(baseline, current, "not_comparable", "The claims describe different identities.");
  const supports = current.evidence.some(({ stance }) => stance === "supports");
  const contradicts = current.evidence.some(({ stance }) => stance === "contradicts");
  if (supports && contradicts) return result(baseline, current, "conflicting_evidence", "Current evidence supports and contradicts the claim.");
  if (!supports) return result(baseline, current, contradicts ? "answer_needs_correction" : "unverified", "Current evidence does not support the extracted claim.");
  if (baseline.comparabilityKey !== current.comparabilityKey) {
    const currencyChanged = baseline.value.kind === "price" && current.value.kind === "price" && baseline.value.currency !== current.value.currency;
    return result(baseline, current, currencyChanged ? "terms_changed" : "not_comparable", "Price terms differ, so amounts cannot be compared directly.");
  }
  if (equalValue(baseline.value, current.value)) return result(baseline, current, "unchanged", "The comparable values match.", { materiality: "cosmetic", delta: "0" });
  if (baseline.value.kind === "price" && current.value.kind === "price") {
    const delta = decimalDelta(baseline.value.amountDecimal, current.value.amountDecimal);
    // shortcut: suppress changes below one currency unit until the product defines a materiality policy.
    if (lessThanOne(delta)) return result(baseline, current, "unchanged", "The price difference is under one currency unit and is suppressed as immaterial.", { materiality: "cosmetic", delta });
    return result(baseline, current, "confirmed_change", "The comparable price changed.", {
      materiality: "material", delta,
      twentySeatImpact: baseline.value.basis === "seat" ? multiplyDecimal(delta, 20) : null,
    });
  }
  return result(baseline, current, "confirmed_change", "The comparable value changed.", { materiality: "material" });
}
