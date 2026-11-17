import assert from "node:assert/strict";
import test from "node:test";
import { comparisonStartMs, resolveAnchor } from "../src/time/resolve-anchor.js";

test("last Tuesday selects the previous calendar week, including on Tuesday", () => {
  const anchor = resolveAnchor("What did we discuss last Tuesday?", "2026-11-17T18:00:00Z", "UTC");
  assert.equal(anchor?.primary.localStart, "2026-11-10");
  assert.equal(resolveAnchor("last Tuesday", "2026-11-15T18:00:00Z", "UTC")?.primary.localStart, "2026-11-03");
  assert.equal(resolveAnchor("last Tuesday", "2026-11-16T18:00:00Z", "UTC")?.primary.localStart, "2026-11-10");
  assert.equal(resolveAnchor("last Tuesday", "2026-11-15T18:00:00Z", "UTC", 7)?.primary.localStart, "2026-11-10");
});

test("a bare weekday today discloses the previous matching day", () => {
  const anchor = resolveAnchor("What did I ask on Monday?", "2026-11-16T18:00:00Z", "UTC");
  assert.equal(anchor?.primary.localStart, "2026-11-16");
  assert.equal(anchor?.alternatives[0]?.localStart, "2026-11-09");
  assert.equal(anchor?.ambiguous, true);
  assert.ok(anchor?.disclosure);
});

test("a no-year November date rolls back to the previous year", () => {
  const anchor = resolveAnchor("What did I ask on 3 November?", "2026-01-12T18:00:00Z", "UTC");
  assert.equal(anchor?.primary.localStart, "2025-11-03");
});

test("local-day intervals span 23 and 25 hours across DST", () => {
  const spring = resolveAnchor("today", "2026-03-08T20:00:00Z", "America/Los_Angeles");
  const fall = resolveAnchor("today", "2026-11-01T20:00:00Z", "America/Los_Angeles");
  assert.equal(spring!.primary.endMsExclusive - spring!.primary.startMs, 23 * 60 * 60 * 1000);
  assert.equal(fall!.primary.endMsExclusive - fall!.primary.startMs, 25 * 60 * 60 * 1000);
});

test("since uses the recalled episode timestamp as its comparison boundary", () => {
  const anchor = resolveAnchor("What changed since Monday?", "2026-11-17T18:00:00Z", "UTC");
  assert.equal(anchor?.comparisonBoundary, "episode_timestamp");
  assert.equal(comparisonStartMs(anchor!, 1234), 1234);
});
