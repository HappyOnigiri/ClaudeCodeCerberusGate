import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, started, verdict, deferred, tick } from "./helpers/gate-harness.ts";
import {
  readConfig,
  reviewMode,
  PASSED,
  UNVERIFIED,
  REVISION_LIMIT,
} from "../plugins/cerberus-gate/hooks/policy.ts";
import { forkPrompt } from "../plugins/cerberus-gate/hooks/fork-prompt.ts";

const fork = (options: Record<string, unknown> = {}) =>
  harness({ reviewerModel: "inherit", ...options });
void test("configuration selects fork only when both values are literally inherit", async () => {
  assert.equal(reviewMode(readConfig({})), "fork");
  for (const options of [{ reviewerModel: "haiku" }, { reviewerEffort: "low" }]) {
    assert.equal(reviewMode(readConfig(options)), "complete");
    const h = fork(options);
    await started(h);
    await h.step();
    assert.equal(h.events.models.length, 1);
    assert.equal(h.events.forks.length, 0);
  }
});
void test("fork PASS releases exact draft without complete, tools or materials", async () => {
  const h = fork();
  await started(h);
  h.engine.tool.list = async () => {
    throw new Error("fork must not list tools");
  };
  h.setPreparation(async () => {
    throw new Error("fork must not prepare materials");
  });
  const result = await h.step();
  assert.equal(result.text, "UNPUBLISHED DRAFT");
  assert.deepEqual(result.notes, [PASSED]);
  assert.equal(h.events.forks.length, 1);
  assert.deepEqual(h.events.models, []);
  assert.deepEqual(h.events.calls, []);
  assert.deepEqual(h.events.materialRequests, []);
  assert.equal(h.events.released, undefined);
  assert.match(h.events.forks[0]!.prompt, /original request/u);
  assert.match(h.events.forks[0]!.prompt, /UNPUBLISHED DRAFT/u);
});
void test("fork invalid, tool, empty and failed replies are UNVERIFIED without retries or fallback", async () => {
  for (const reply of [
    "",
    "PASS",
    "{}",
    '{"tool":"Read","input":{}}',
    '{"decision":"PASS","findings":[],"tool":"Read"}',
    verdict("UNVERIFIED"),
    () => ({ isAnswered: false, reason: "nothing-to-fork" }),
    () => ({ isAnswered: false, reason: "api-error", usage: {} }),
    () => {
      throw new Error("fork failed");
    },
  ]) {
    const h = fork();
    await started(h);
    h.replies.push(reply);
    const result = await h.step();
    assert.equal(result.text, "UNPUBLISHED DRAFT");
    assert.deepEqual(result.notes, [UNVERIFIED]);
    assert.equal(h.events.forks.length, 1);
    assert.equal(h.events.models.length, 0);
    assert.equal(h.events.prompts.length, 0);
  }
});
void test("positive correction cap reviews the final correction and preserves unresolved verdict", async () => {
  for (const method of ["inherit", "haiku"])
    for (const decision of ["PASS", "REVISE", "UNVERIFIED"]) {
      const h = fork({ reviewerModel: method, maxRevisions: 1 });
      await started(h);
      h.replies.push(verdict("REVISE", ["fact.txt: missing successful read; re-present evidence"]));
      assert.equal((await h.step()).text, "");
      await h.flushCorrections();
      h.replies.push(verdict(decision, decision === "REVISE" ? ["still missing"] : []));
      const result = await h.step({ text: "CORRECTED" });
      assert.equal(result.text, "CORRECTED");
      assert.deepEqual(result.notes, [decision === "PASS" ? PASSED : UNVERIFIED]);
      await h.flushCorrections();
      assert.equal(h.events.prompts.length, 1);
      assert.equal(h.events.models.length + h.events.forks.length, 2);
      if (method === "inherit") assert.match(h.events.forks[1]!.prompt, /fact.txt: missing/u);
    }
});
void test("zero cap skips fork and disabled review passes through", async () => {
  for (const options of [{ maxRevisions: 0 }, { enabled: false }]) {
    const h = fork(options);
    await started(h);
    const result = await h.step();
    assert.deepEqual(result.notes, "maxRevisions" in options ? [REVISION_LIMIT] : []);
    assert.equal(h.events.forks.length, 0);
  }
});
void test("fork timeout and invalidation stop waiting and discard late results with usage", async () => {
  for (const cause of ["timeout", "cancel", "request", "abort", "end", "unload"]) {
    const h = fork();
    await started(h);
    const late = deferred();
    h.replies.push(() => late.promise);
    const running = h.step();
    await tick();
    if (cause === "timeout") await h.events.timers[0]!.fn();
    if (cause === "cancel") await h.fire("command.run", { command: "cgate", args: "cancel" });
    if (cause === "request") await h.prompt("new request");
    if (cause === "abort") await h.fire("turn.abort", {});
    if (cause === "end") await h.fire("session.end", {});
    if (cause === "unload") h.unload();
    const result = await running;
    assert.equal(result.text, cause === "timeout" ? "UNPUBLISHED DRAFT" : "");
    late.resolve({
      isAnswered: true,
      text: verdict("REVISE", ["stale"]),
      usage: { output_tokens: 7 },
    });
    await tick();
    await h.fire("command.run", { command: "cgate", args: "log" });
    await tick();
    assert.ok(h.events.debug.some((r) => r.event === "model.discarded"));
    assert.equal(h.events.prompts.length, 0);
  }
});
void test("fork holds questions and replays them only after PASS", async () => {
  const h = fork();
  await started(h);
  const tools = [{ name: "AskUserQuestion", input: { questions: [] } }];
  h.replies.push(verdict("REVISE", ["missing support for recommendation"]));
  assert.deepEqual((await h.step({ tools, stopReason: "tool_use" })).result.toolUses, []);
  await h.flushCorrections();
  h.replies.push(verdict());
  const passed = await h.step({ tools, stopReason: "tool_use" });
  assert.deepEqual(passed.result.toolUses, tools);
});
void test("fork custom criteria retain fixed English and Japanese contracts", () => {
  for (const language of ["en", "ja"]) {
    const prompt = forkPrompt(
      readConfig({ language, reviewPrompt: "CUSTOM" }),
      "request",
      "draft",
      ["gap"],
    );
    assert.ok(prompt.startsWith("CUSTOM\n"));
    assert.match(prompt, /UNVERIFIED/u);
    assert.match(prompt, /previousFindings/u);
    assert.match(prompt, language === "ja" ? /ツールは使えません/u : /NO tools/u);
    assert.doesNotMatch(prompt, /sessionLog.history|HISTORY GATE/u);
  }
});

void test("changing settings during a fork affects only the next review", async () => {
  const h = fork();
  await started(h);
  const late = deferred();
  h.replies.push(() => late.promise);
  const running = h.step();
  await tick();
  const pane = await h.fire("ui.render", {
    component: "Pane",
    requestId: "reviewer-model",
    surface: "terminal",
  });
  await pane.onSelect("haiku");
  late.resolve({ isAnswered: true, text: verdict(), usage: {} });
  assert.deepEqual((await running).notes, [PASSED]);
  assert.equal(h.events.models.length, 0);
  await h.step();
  assert.equal(h.events.models.length, 1);
  assert.equal(h.events.forks.length, 1);
});
void test("a reload invalidates an old fork before a fresh review", async () => {
  const h = fork();
  await started(h);
  const late = deferred();
  h.replies.push(() => late.promise);
  const running = h.step();
  await tick();
  h.unload();
  assert.equal((await running).text, "");
  const fresh = await import(`../plugins/cerberus-gate/hooks/register.ts?forkReload=${Date.now()}`);
  const next = harness({ reviewerModel: "inherit" }, "2.1.310", h.host, fresh.register);
  await next.fire("session.start", { isInteractive: true });
  await next.flushCorrections();
  late.resolve({ isAnswered: true, text: verdict("REVISE", ["stale"]), usage: {} });
  await tick();
  assert.equal(h.events.prompts.length, 0);
  assert.deepEqual((await next.step()).notes, [PASSED]);
});

void test("a denied native fork tool attempt cannot be followed by PASS", async () => {
  const h = fork();
  await started(h);
  h.setCall({ isError: true, text: "A model fork cannot use tools" });
  h.replies.push(async () => {
    await h.fire("tool.call", { tool: "Read", agentId: "fork-agent" });
    return { isAnswered: true, text: verdict(), usage: {} };
  });
  assert.deepEqual((await h.step()).notes, [UNVERIFIED]);
});
