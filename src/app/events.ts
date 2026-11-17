export type ServerEvent =
  | { type: "run_started"; runId: string }
  | { type: "anchor_resolved"; disclosure: string | null }
  | { type: "memory_found"; episodeTitle: string; entityNames: string[] }
  | { type: "tool_started"; callId: string; query: string; wave: number }
  | { type: "tool_finished"; callId: string; status: string; latencyMs: number }
  | { type: "verification_progress"; checked: number; total: number }
  | { type: "answer_delta"; text: string }
  | { type: "answer_final"; answerTurnId: string; coverage: Record<string, number> }
  | { type: "run_failed"; recoverableMessage: string }
  | { type: "heartbeat"; at: string };
