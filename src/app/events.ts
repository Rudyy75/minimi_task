export type ServerEvent =
  | { type: "run_started"; runId: string }
  | { type: "run_state"; state: string }
  | { type: "clarify"; question: string }
  | { type: "anchor_resolved"; disclosure: string | null; interval?: { localStart: string; localEndExclusive: string; startUtc: string; endUtcExclusive: string } }
  | { type: "memory_found"; episodeTitle: string; entityNames: string[] }
  | { type: "tool_started"; callId: string; query: string; wave: number }
  | { type: "tool_finished"; callId: string; status: string; latencyMs: number }
  | { type: "verification_progress"; checked: number; total: number }
  | { type: "answer_delta"; text: string }
  | { type: "answer_final"; answerTurnId: string; answer: string; coverage: Record<string, number>; verdicts?: { entity: string; baseline: string | null; current: string | null; status: string; confidence: string; citations: { title: string; url: string }[] }[] }
  | { type: "run_failed"; recoverableMessage: string }
  | { type: "heartbeat"; at: string };
