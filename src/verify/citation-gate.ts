import type { Verification } from "./diff.js";

export interface CitationSource { id: string; url: string; title: string; supportsClaimIds: readonly string[] }

export function gateCitations(answer: string, verdicts: readonly Verification[], sources: readonly CitationSource[]): string {
  const trusted = new Map(sources.map((source) => [source.id, source]));
  const supportedClaims = new Set(verdicts.flatMap((verdict) => verdict.currentClaimId ? [verdict.currentClaimId] : []));
  const withoutUrls = answer.replace(/https?:\/\/[^\s)\]]+/gi, "");
  return withoutUrls.replace(/\[\[([^\]]+)\]\]/g, (_token, id: string) => {
    const source = trusted.get(id);
    if (!source) throw new Error(`Unknown citation ID: ${id}`);
    if (!source.supportsClaimIds.some((claimId) => supportedClaims.has(claimId) && verdicts.some((verdict) => verdict.currentClaimId === claimId && verdict.evidenceIds.includes(id)))) {
      throw new Error(`Citation ${id} does not support a verified claim`);
    }
    const url = new URL(source.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Citation ${id} has an unsafe URL`);
    const title = source.title.replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&");
    const href = url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[${title}](${href})`;
  }).trim();
}
