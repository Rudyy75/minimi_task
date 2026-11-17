import { randomUUID } from "node:crypto";
import type { Clock } from "../time/clock.js";

export interface RequestContext {
  requestId: string;
  conversationId: string;
  nowUtc: string;
  nowMs: number;
  timeZone: string;
  locale: string;
  weekStartsOn: 1 | 7;
}

export function createRequestContext(
  clock: Clock,
  options: { conversationId?: string; timeZone: string; locale: string },
): RequestContext {
  const now = clock.now();
  return {
    requestId: randomUUID(),
    conversationId: options.conversationId ?? randomUUID(),
    nowUtc: now.toISOString(),
    nowMs: now.getTime(),
    timeZone: options.timeZone,
    locale: options.locale,
    weekStartsOn: 1,
  };
}
