import type { ResolvedAnchor } from "../time/resolve-anchor.js";

export type Route = "MEMORY_LOOKUP" | "DIRECT" | "VERIFY_TEMPORAL" | "RESEARCH_MULTI_ENTITY" | "CLARIFY";

const verificationIntent = /\b(still correct|current price|current pricing|changed|changes|since)\b/i;
const memoryIntent = /\b(what did i ask|what did we discuss|what did i say|remember when)\b/i;
const comparisonIntent = /\b(compare|comparison|versus|\bvs\.?\b)\b/i;

export function routePrompt(prompt: string, context: { anchor?: ResolvedAnchor | null; episodeCount?: number; entityCount?: number } = {}): Route {
  const verify = verificationIntent.test(prompt);
  if (context.anchor?.ambiguous) return "CLARIFY";
  if (verify) return "VERIFY_TEMPORAL";
  if (memoryIntent.test(prompt)) return context.episodeCount ? "MEMORY_LOOKUP" : "CLARIFY";
  if (comparisonIntent.test(prompt) && (context.entityCount ?? 0) > 1) return "RESEARCH_MULTI_ENTITY";
  return "DIRECT";
}

export function buildSearchWaves(prompt: string, route: Route, entities: readonly string[]): { query: string; wave: 1 | 2 }[][] {
  if (route !== "VERIFY_TEMPORAL" && route !== "RESEARCH_MULTI_ENTITY") return [];
  const names = [...new Set(entities)].slice(0, 5);
  const wave1 = (names.length ? names.map((name) => ({ query: `${name} official pricing`, wave: 1 as const })) : [{ query: prompt, wave: 1 as const }]);
  const wave2 = /\b(shipped|launch|release|feature|audit\s+logs?|plan\s+limits?)\b/i.test(prompt)
    ? names.slice(0, 5).map((name) => ({ query: `${name} official release notes features`, wave: 2 as const }))
    : [];
  return [wave1, ...(wave2.length ? [wave2] : [])];
}
