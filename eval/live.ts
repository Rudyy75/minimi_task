import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { TavilySearchPort } from "../src/research/search-adapter.js";
import { OpenAIResponsesPort } from "../src/research/llm-adapter.js";
import { systemClock } from "../src/time/clock.js";

if (!config.TAVILY_API_KEY || !config.OPENAI_API_KEY) throw new Error("Set TAVILY_API_KEY and OPENAI_API_KEY to run eval:live");
const signal = AbortSignal.timeout(15_000);
const search = await new TavilySearchPort(config.TAVILY_API_KEY, systemClock).search("OpenAI official pricing", signal);
const answer = await new OpenAIResponsesPort(config.OPENAI_API_KEY, config.OPENAI_MODEL).complete("Reply with READY only.", signal);
assert.ok(search.results.length > 0, "Live search returned no results");
assert.match(answer, /READY/i, "Live model did not return READY");
console.log(JSON.stringify({ searchProvider: search.provider, searchResults: search.results.length, model: config.OPENAI_MODEL, llmOk: true }, null, 2));
