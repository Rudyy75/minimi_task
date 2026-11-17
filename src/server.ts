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
import { captureLiveEpisode, saveUserTurn } from "./memory/turn-repository.js";
import { recallByInterval } from "./memory/recall.js";
import { saveAnchor } from "./memory/anchor-repository.js";
import { routePrompt, buildSearchWaves } from "./app/router.js";
import { RunStateMachine } from "./app/state-machine.js";
import { createDemoSearchPort, TavilySearchPort } from "./research/search-adapter.js";
import { SearchRunner } from "./research/search-runner.js";
import { resolveAnchor } from "./time/resolve-anchor.js";
import { systemClock } from "./time/clock.js";

const app = Fastify({ logger: true });
const chatRequest = z.object({
  conversationId: z.string().uuid().optional(),
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
    send({ type: "clarify", question: anchor?.disclosure ?? "I couldn't find a matching conversation. Which date or comparison do you mean?" });
  } else if (turn && route === "MEMORY_LOOKUP") {
    setState("fast_answer");
    for (const episode of recalled?.episodes ?? []) send({ type: "memory_found", episodeTitle: episode.title, entityNames: episode.entities.map((entity) => entity.display_name) });
    for (const item of recalled?.turns ?? []) send({ type: "answer_delta", text: item.content });
  } else if (turn && (route === "VERIFY_TEMPORAL" || route === "RESEARCH_MULTI_ENTITY")) {
    const entityNames = (recalled?.episodes ?? []).flatMap((episode) => episode.entities.map((entity) => entity.display_name));
    const waves = buildSearchWaves(turn.content, route, entityNames);
    setState("planned");
    setState("searching");
    const outcome = await searchRunner.run({ requestTurnId: turn.id, runId, waves, signal: abortController.signal, onEvent: send });
    if (abortController.signal.aborted) setState("cancelled");
    else if (outcome.failures.length) setState("degraded");
    else setState("extracting");
  }
  if (!response.destroyed) send({ type: "heartbeat", at: context.nowUtc });
});

app.addHook("onClose", async () => db.close());
await app.listen({ port: config.PORT, host: config.HOST });
