export type RunStateType = "received" | "time_resolved" | "recalled" | "clarify" | "fast_answer" | "planned" | "searching" | "extracting" | "diffing" | "synthesizing" | "degraded" | "committed" | "cancelled";

const allowed: Record<RunStateType, readonly RunStateType[]> = {
  received: ["time_resolved", "cancelled"],
  time_resolved: ["recalled", "cancelled"],
  recalled: ["clarify", "fast_answer", "planned", "committed", "cancelled"],
  clarify: ["committed", "cancelled"],
  fast_answer: ["committed", "cancelled"],
  planned: ["searching", "cancelled"],
  searching: ["extracting", "degraded", "cancelled"],
  extracting: ["diffing", "degraded", "cancelled"],
  diffing: ["synthesizing", "degraded", "cancelled"],
  synthesizing: ["committed", "degraded", "cancelled"],
  degraded: ["committed", "cancelled"],
  committed: [],
  cancelled: [],
};

export class RunStateMachine {
  private state: RunStateType = "received";

  get current(): RunStateType { return this.state; }

  transition(next: RunStateType): RunStateType {
    if (!allowed[this.state].includes(next)) throw new Error(`Invalid run transition: ${this.state} -> ${next}`);
    this.state = next;
    return this.state;
  }
}
