import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { createRequestContext } from "./app/context.js";
import type { ServerEvent } from "./app/events.js";
import { openDatabase } from "./memory/db.js";
import { seedDemo } from "./memory/seed-demo.js";
import { captureLiveEpisode, markTurnPartial, saveAssistantAnswer, saveUserTurn } from "./memory/turn-repository.js";
import { recallByInterval } from "./memory/recall.js";
import { saveAnchor } from "./memory/anchor-repository.js";
import { routePrompt, buildSearchWaves } from "./app/router.js";
import { RunStateMachine } from "./app/state-machine.js";
import { createDemoSearchPort, TavilySearchPort } from "./research/search-adapter.js";
import { SearchRunner } from "./research/search-runner.js";
import { OpenAIResponsesPort } from "./research/llm-adapter.js";
import { resolveAnchor } from "./time/resolve-anchor.js";
import { systemClock } from "./time/clock.js";
import { verifySearchResults } from "./verify/pipeline.js";

const app = Fastify({ logger: true });
const chatRequest = z.object({
  conversationId: z.string().min(1).max(200).optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20_000).optional(),
}).optional();
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const db = openDatabase(config.DATABASE_PATH);
seedDemo(db, systemClock, config.TIME_ZONE);
const searchPort = config.TAVILY_API_KEY
  ? new TavilySearchPort(config.TAVILY_API_KEY, systemClock)
  : createDemoSearchPort(systemClock);
const searchRunner = new SearchRunner(db, searchPort, systemClock);
const llm = config.OPENAI_API_KEY ? new OpenAIResponsesPort(config.OPENAI_API_KEY, config.OPENAI_MODEL) : undefined;
await app.register(fastifyStatic, { root: publicDir });

app.get("/api/health", async () => ({ ok: true }));
app.post("/api/chat", async (request, reply) => {
  const body = chatRequest.parse(request.body);
  const context = createRequestContext(systemClock, {
    conversationId: body?.conversationId,
    timeZone: config.TIME_ZONE,
    locale: config.LOCALE,
  });
  const runId = randomUUID();
  const turn = body?.message ? saveUserTurn(db, context, { userId: "local", content: body.message, clientMessageId: body.clientMessageId, runId }) : null;
  const captured = turn ? captureLiveEpisode(db, turn) : null;
  const anchor = turn ? captured?.anchor ?? resolveAnchor(turn.content, turn.createdAtUtc, turn.timeZone) : null;
  if (turn && anchor && !captured) saveAnchor(db, turn.id, anchor);
  const recalled = turn && anchor ? recallByInterval(db, turn.conversationId, anchor.primary, turn.content) : null;
  const route = turn ? routePrompt(turn.content, { anchor, episodeCount: recalled?.episodes.length, entityCount: recalled?.episodes.reduce((count, episode) => count + episode.entities.length, 0) }) : null;
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": context.requestId,
  });
  let eventSeq = 0;
  const send = (event: ServerEvent) => {
    if (event.type !== "heartbeat") {
      db.prepare(`INSERT INTO run_events (run_id, seq, at_ms, event_type, event_json)
        VALUES (?, ?, ?, ?, ?)`)
        .run(runId, ++eventSeq, systemClock.now().getTime(), event.type, JSON.stringify(event));
    }
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const machine = new RunStateMachine();
  const setState = (state: Parameters<typeof machine.transition>[0]) => send({ type: "run_state", state: machine.transition(state) });
  send({ type: "run_started", runId });
  const abortController = new AbortController();
  const timer = setInterval(() => send({ type: "heartbeat", at: systemClock.now().toISOString() }), 15_000);
  response.on("close", () => {
    clearInterval(timer);
    if (!response.writableEnded) abortController.abort(new DOMException("Client disconnected", "AbortError"));
  });
  if (turn) {
    setState("time_resolved");
    setState("recalled");
  }
  if (anchor) {
    send({ type: "anchor_resolved", disclosure: anchor.disclosure, interval: {
      localStart: anchor.primary.localStart,
      localEndExclusive: anchor.primary.localEndExclusive,
      startUtc: anchor.primary.startUtc,
      endUtcExclusive: anchor.primary.endUtcExclusive,
    } });
  }
  if (captured) send({ type: "memory_found", episodeTitle: `${captured.anchor.kind} · ${captured.anchor.primary.localStart}`, entityNames: [] });

  if (turn && route === "CLARIFY") {
    setState("clarify");
    const question = anchor?.disclosure ?? "I couldn't find a matching conversation. Which date or comparison do you mean?";
    const answerTurnId = saveAssistantAnswer(db, context, { requestTurnId: turn.id, runId, content: question });
    send({ type: "clarify", question });
    send({ type: "answer_final", answerTurnId, answer: question, coverage: { inScope: 0, fullyChecked: 0, unverified: 0, conflicting: 0 } });
    setState("committed");
  } else if (turn && route === "MEMORY_LOOKUP") {
    setState("fast_answer");
    for (const episode of recalled?.episodes ?? []) send({ type: "memory_found", episodeTitle: episode.title, entityNames: episode.entities.map((entity) => entity.display_name) });
    const answer = recalled?.turns.length ? recalled.turns.map((item) => item.content).join("\n") : "I couldn't find a matching saved question in that time window.";
    const answerTurnId = saveAssistantAnswer(db, context, { requestTurnId: turn.id, runId, content: answer, episodeId: recalled?.episodes[0]?.id });
    send({ type: "answer_delta", text: answer });
    send({ type: "answer_final", answerTurnId, answer, coverage: { inScope: recalled?.turns.length ?? 0, fullyChecked: 0, unverified: 0, conflicting: 0 } });
    setState("committed");
  } else if (turn && (route === "VERIFY_TEMPORAL" || route === "RESEARCH_MULTI_ENTITY")) {
    const episodeIds = (recalled?.episodes ?? []).map(({ id }) => id);
    const entities = (recalled?.episodes ?? []).flatMap((episode) => episode.entities);
    const entityNames = entities.map((entity) => entity.display_name);
    const entityIds = new Map(entities.map((entity) => [entity.display_name.toLowerCase(), entity.id]));
    const waves = buildSearchWaves(turn.content, route, entityNames);
    setState("planned");
    setState("searching");
    const outcome = await searchRunner.run({ requestTurnId: turn.id, runId, waves, signal: abortController.signal, onEvent: send });
    if (abortController.signal.aborted) { markTurnPartial(db, turn.id); setState("cancelled"); }
    else {
      setState("extracting");
      try {
        await verifySearchResults(db, { context, requestTurnId: turn.id, runId, question: turn.content,
          episodeIds, entityIds, results: outcome.results, providerFailures: outcome.failures, llm,
          signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(8_000)]), send });
        setState(outcome.failures.length ? "degraded" : "committed");
        if (outcome.failures.length) setState("committed");
      } catch (error) {
        if (abortController.signal.aborted) { markTurnPartial(db, turn.id); setState("cancelled"); }
        else {
          send({ type: "run_failed", recoverableMessage: error instanceof Error ? error.message : "Verification failed" });
          setState("degraded");
          setState("committed");
        }
      }
    }
  } else if (turn) {
    setState("fast_answer");
    let answer = "I can recall a saved conversation or verify a dated comparison. Include a date or name the shortlist you want me to check.";
    if (llm) {
      try { answer = await llm.complete(`Answer the user's general question clearly. Do not claim to have searched or verified current facts. If the user asks for current information, ask them to use a dated verification request.\n\nUser: ${turn.content}`, AbortSignal.any([abortController.signal, AbortSignal.timeout(8_000)])); }
      catch { if (abortController.signal.aborted) { markTurnPartial(db, turn.id); setState("cancelled"); return; } }
    }
    const answerTurnId = saveAssistantAnswer(db, context, { requestTurnId: turn.id, runId, content: answer });
    send({ type: "answer_delta", text: answer });
    send({ type: "answer_final", answerTurnId, answer, coverage: { inScope: 0, fullyChecked: 0, unverified: 0, conflicting: 0 } });
    setState("committed");
  }
  clearInterval(timer);
  if (!response.destroyed) response.end();
});

app.addHook("onClose", async () => db.close());
await app.listen({ port: config.PORT, host: config.HOST });
