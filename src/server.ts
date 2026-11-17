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
import { systemClock } from "./time/clock.js";

const app = Fastify({ logger: true });
const chatRequest = z.object({ conversationId: z.string().uuid().optional() }).optional();
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const db = openDatabase(config.DATABASE_PATH);
seedDemo(db, systemClock, config.TIME_ZONE);
await app.register(fastifyStatic, { root: publicDir });

app.get("/api/health", async () => ({ ok: true }));
app.post("/api/chat", async (request, reply) => {
  const body = chatRequest.parse(request.body);
  const context = createRequestContext(systemClock, {
    conversationId: body?.conversationId,
    timeZone: config.TIME_ZONE,
    locale: config.LOCALE,
  });
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": context.requestId,
  });
  const send = (event: ServerEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "run_started", runId: randomUUID() });
  send({ type: "heartbeat", at: context.nowUtc });
  const timer = setInterval(() => send({ type: "heartbeat", at: systemClock.now().toISOString() }), 15_000);
  response.on("close", () => clearInterval(timer));
});

app.addHook("onClose", async () => db.close());
await app.listen({ port: config.PORT, host: config.HOST });
