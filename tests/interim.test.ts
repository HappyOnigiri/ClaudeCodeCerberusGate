import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSED,
  REVISION_LIMIT,
  readConfig,
  revising,
  skipped,
} from "../plugins/cerberus-gate/hooks/policy.ts";

import { harness, verdict, started } from "./helpers/gate-harness.ts";

const shown = (r: { text: string; notes: string[] }) => ({ notes: r.notes, text: r.text });
const noted = (note: string, text: string) => ({ notes: [note], text });
const DRAFT = "UNPUBLISHED DRAFT";
const agent = (status: string, extra: Record<string, string> = {}) => ({
  id: `agent-${status}`,
  type: "general-purpose",
  status,
  ...extra,
});
const notification = (id: string) => ({
  text: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
  origin: { kind: "task-notification" },
  wait: false,
});
// The main loop's Bash call the engine moved to the background.
const backgroundShell = async (h: ReturnType<typeof harness>, id: string) => {
  h.setCall({ result: { backgroundTaskId: id } });
  await h.fire("tool.call", { tool: "Bash", command: "sleep 60", run_in_background: true });
};

void test("a short answer while the main loop's subagent runs is shown without review", async () => {
  for (const status of ["pending", "running", "waiting"]) {
    const h = harness();
    await started(h);
    h.host.reviewers.push(agent(status));
    assert.deepEqual(shown(await h.step()), noted(skipped(1, 0, DRAFT.length), DRAFT));
    assert.equal(h.events.models.length, 0);
    assert.equal(h.events.debug.at(-1)?.event, "review.skipped");
  }
});

void test("an interim report at the length limit is skipped and one character more is reviewed", async () => {
  const h = harness({ interimMaxChars: DRAFT.length });
  await started(h);
  h.host.reviewers.push(agent("running"));
  assert.deepEqual(shown(await h.step()), noted(skipped(1, 0, DRAFT.length), DRAFT));
  h.replies.push(verdict());
  const longer = `${DRAFT}!`;
  assert.deepEqual(shown(await h.step({ text: longer })), noted(PASSED, longer));
  assert.equal(h.events.models.length, 1);
});

void test("ended, nested, reviewer and teammate-idle agents do not make an answer interim", async () => {
  const h = harness();
  await started(h);
  h.host.reviewers.push(
    agent("completed"),
    agent("idle"),
    agent("running", { parentId: "agent-completed", id: "nested" }),
    agent("running", { spawnedBy: "cerberus-gate", id: "reviewer" }),
  );
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("interimMaxChars 0 reviews every answer even while background work runs", async () => {
  const h = harness({ interimMaxChars: 0 });
  await started(h);
  h.host.reviewers.push(agent("running"));
  await backgroundShell(h, "b1");
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("a main background shell counts until its notification or its TaskStop", async () => {
  const h = harness();
  await started(h);
  await backgroundShell(h, "b1");
  await backgroundShell(h, "b2");
  assert.deepEqual(shown(await h.step()), noted(skipped(0, 2, DRAFT.length), DRAFT));
  await h.fire("prompt.submit", notification("b1"));
  assert.deepEqual(shown(await h.step()), noted(skipped(0, 1, DRAFT.length), DRAFT));
  h.setCall({ result: "stopped" });
  await h.fire("tool.call", { tool: "TaskStop", task_id: "b2" });
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("an ended main subagent counts until its notification reaches the main loop", async () => {
  const h = harness();
  await started(h);
  h.setCall({ result: { status: "async_launched", agentId: "agent-completed" } });
  await h.fire("tool.call", { tool: "Agent", prompt: "review", run_in_background: true });
  h.host.reviewers.push(agent("completed"));
  assert.deepEqual(shown(await h.step()), noted(skipped(1, 0, DRAFT.length), DRAFT));
  await h.fire("prompt.submit", notification("agent-completed"));
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("a new user request forgets the earlier request's unnotified subagents", async () => {
  const h = harness();
  await started(h);
  h.setCall({ result: { status: "async_launched", agentId: "agent-completed" } });
  await h.fire("tool.call", { tool: "Agent", prompt: "review", run_in_background: true });
  h.host.reviewers.push(agent("completed"));
  await h.prompt("next request");
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("a new user request forgets the earlier request's background shells", async () => {
  const h = harness();
  await started(h);
  await backgroundShell(h, "server");
  await h.prompt("next request");
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("subagent and reviewer background commands are not the main loop's shells", async () => {
  const h = harness();
  await started(h);
  h.setCall({ result: { backgroundTaskId: "sub" } });
  await h.fire("tool.call", { tool: "Bash", command: "sleep 60", agentId: "agent-x" });
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
});

void test("an interim report in a correction turn keeps the cycle and its correction count", async () => {
  const h = harness({ maxRevisions: 2 });
  await started(h);
  h.replies.push(verdict("REVISE", ["first finding"]));
  assert.deepEqual(shown(await h.step()), noted(revising(1), ""));
  await h.flushCorrections();
  h.host.reviewers.push(agent("running"));
  h.setDraft("WAITING FOR AGENT");
  assert.deepEqual(
    shown(await h.step()),
    noted(skipped(1, 0, "WAITING FOR AGENT".length), "WAITING FOR AGENT"),
  );
  assert.equal(h.host.states.get("recovery")!.pending, true);
  h.host.reviewers[0]!.status = "completed";
  await h.fire("prompt.submit", notification("agent-running"));
  h.setDraft("CORRECTED");
  h.replies.push(verdict("REVISE", ["second finding"]));
  assert.deepEqual(shown(await h.step()), noted(revising(2), ""));
});

void test("a failing agent list reviews the answer instead of skipping it", async () => {
  const h = harness();
  await started(h);
  h.engine.agent.list = async () => {
    throw new Error("agent list unavailable");
  };
  h.replies.push(verdict());
  assert.deepEqual(shown(await h.step()), noted(PASSED, DRAFT));
  assert.ok(h.events.debug.some((r) => r.event === "interim.failed"));
});

void test("interimMaxChars defaults to 500 and rejects values outside 0 to 100000", () => {
  assert.equal(readConfig({}).interimMaxChars, 500);
  for (const value of [0, 100_000])
    assert.equal(readConfig({ interimMaxChars: value }).interimMaxChars, value);
  for (const value of [-1, 100_001, 1.5, "500"])
    assert.throws(() => readConfig({ interimMaxChars: value }), /Invalid interimMaxChars/u);
});

void test("an interim report at the revision cap keeps the cycle until the final answer skips review", async () => {
  const h = harness({ maxRevisions: 1 });
  await started(h);
  h.replies.push(verdict("REVISE", ["finding"]));
  await h.step();
  await h.flushCorrections();
  h.host.reviewers.push(agent("running"));
  h.setDraft("WAITING FOR AGENT");
  assert.deepEqual(
    shown(await h.step()),
    noted(skipped(1, 0, "WAITING FOR AGENT".length), "WAITING FOR AGENT"),
  );
  assert.equal(h.host.states.get("recovery")!.pending, true);
  h.host.reviewers[0]!.status = "completed";
  await h.fire("prompt.submit", notification("agent-running"));
  h.setDraft("CORRECTED");
  const reviewsAtCap = h.events.models.length;
  const materialsAtCap = h.events.materialRequests.length;
  assert.deepEqual(shown(await h.step()), noted(REVISION_LIMIT, "CORRECTED"));
  assert.equal(h.events.models.length, reviewsAtCap);
  assert.equal(h.events.materialRequests.length, materialsAtCap);
  assert.equal(h.host.states.get("recovery")!.pending, false);
});
