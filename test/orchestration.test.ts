import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchWaves, routePrompt } from "../src/app/router.js";
import { RunStateMachine } from "../src/app/state-machine.js";
import { resolveAnchor } from "../src/time/resolve-anchor.js";

test("hard verification intent cannot be routed to direct chat; unresolved memory asks clarify", () => {
  assert.equal(routePrompt("Are these current prices still correct?"), "VERIFY_TEMPORAL");
  assert.equal(routePrompt("What did I ask on November 3?", { episodeCount: 1 }), "MEMORY_LOOKUP");
  assert.equal(routePrompt("What did I ask on November 3?", { episodeCount: 0 }), "CLARIFY");
  const ambiguous = resolveAnchor("What did I ask on Monday?", "2026-11-16T18:00:00Z", "UTC");
  assert.equal(routePrompt("What did I ask on Monday?", { anchor: ambiguous, episodeCount: 1 }), "CLARIFY");
});

test("deep research plan stays in two bounded waves and five concurrent queries per CRM wave", () => {
  const entities = ["A", "B", "C", "D", "E", "F"];
  const waves = buildSearchWaves("What changed and did anyone ship a feature?", "VERIFY_TEMPORAL", entities);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves.map((wave) => wave.length), [5, 5]);
  assert.ok(waves.flat().every((task) => task.query.length > 0));
});

test("run state machine rejects unbounded transitions", () => {
  const machine = new RunStateMachine();
  machine.transition("time_resolved");
  machine.transition("recalled");
  machine.transition("planned");
  machine.transition("searching");
  machine.transition("degraded");
  machine.transition("committed");
  assert.equal(machine.current, "committed");
  assert.throws(() => machine.transition("searching"), /Invalid run transition/);
});
