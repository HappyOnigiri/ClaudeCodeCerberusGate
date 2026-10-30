import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, started, verdict, deferred } from "./helpers/gate-harness.ts";
import {
  PASSED,
  UNVERIFIED,
  REVISION_LIMIT,
  revising,
} from "../plugins/cerberus-gate/hooks/policy.ts";

const question = {
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Which release channel should be used?",
        header: "Channel",
        options: [
          { label: "Stable", description: "Use the stable release", preview: "stable preview" },
          { label: "Beta", description: "Use the beta release" },
        ],
        multiSelect: false,
      },
    ],
  },
};
const step = { text: "Choose the release channel.", tools: [question], stopReason: "tool_use" };

void test("question and explanation are held together; PASS replays exact tools and input chunks", async () => {
  const h = harness();
  await started(h);
  const pending = deferred<{ isAnswered: boolean; text: string }>();
  h.replies.push(() => pending.promise);
  const running = h.step(step);
  await new Promise((resolve) => setImmediate(resolve));
  const draft = JSON.parse(JSON.parse(h.events.models[0]!.request.prompt).unpublishedDraft);
  assert.deepEqual(draft, {
    kind: "AskUserQuestion",
    explanation: step.text,
    toolUses: [question],
  });
  assert.equal(h.events.prompts.length, 0);
  pending.resolve({ isAnswered: true, text: verdict() });
  const result = await running;
  assert.equal(result.text, step.text);
  assert.deepEqual(result.result.toolUses, [question]);
  assert.deepEqual(
    result.chunks.filter((c) => c.kind === "input"),
    [{ kind: "input", index: 1, json: JSON.stringify(question.input) }],
  );
  assert.deepEqual(result.notes, [PASSED]);
});

void test("REVISE hides explanation and question calls, then re-reviews corrected questions", async () => {
  const h = harness();
  await started(h);
  h.replies.push(verdict("REVISE", ["Explain the consequences of choosing Beta."]));
  const held = await h.step(step);
  assert.deepEqual(held.chunks, []);
  assert.deepEqual(held.result.toolUses, []);
  assert.deepEqual(held.notes, [revising(1)]);
  await h.flushCorrections();
  assert.equal(h.events.prompts.length, 1);
  assert.match(h.events.prompts[0]!.context.join(""), /call AskUserQuestion again/u);
  assert.match(h.events.prompts[0]!.context.join(""), /stable preview/u);
  const corrected = await h.step({ ...step, text: "Beta enables preview releases." });
  assert.equal(corrected.text, "Beta enables preview releases.");
  assert.deepEqual(corrected.result.toolUses, [question]);
  assert.equal(h.events.models.length, 2);
});

void test("question-only steps, multiple questions and mixed calls are reviewed without interim skipping", async () => {
  const h = harness();
  await started(h);
  await h.fire("tool.call", { tool: "Bash", command: "work" });
  h.host.reviewers.push({ id: "worker", type: "worker", status: "running" });
  const tools = [{ name: "Read", input: { file_path: "fact.txt" } }, question, question];
  const result = await h.step({ ...step, text: "", tools });
  assert.deepEqual(result.result.toolUses, tools);
  assert.equal(result.text, "");
  assert.deepEqual(result.notes, [PASSED]);
  assert.equal(h.events.models.length, 1);
});

void test("unverified and revision cap display original question with notice, never serialized review data", async () => {
  for (const cap of [false, true]) {
    const h = harness(cap ? { maxRevisions: 0 } : {});
    await started(h);
    h.replies.push(verdict("UNVERIFIED"));
    const result = await h.step(step);
    assert.equal(result.text, step.text);
    assert.deepEqual(result.result.toolUses, [question]);
    assert.deepEqual(result.notes, [cap ? REVISION_LIMIT : UNVERIFIED]);
    assert.equal(h.events.materialRequests.length, cap ? 0 : 1);
  }
});

void test("disabled, non-interactive, subagent and ordinary tool steps keep their scope", async () => {
  for (const scope of ["disabled", "non-interactive", "subagent", "ordinary"]) {
    const h = harness({ enabled: scope !== "disabled" });
    await h.fire("session.start", { isInteractive: scope !== "non-interactive" });
    await h.prompt("original request");
    const result = await h.step({
      ...step,
      ...(scope === "subagent" ? { agentId: "worker" } : {}),
      ...(scope === "ordinary"
        ? { tools: [{ name: "Read", input: { file_path: "fact.txt" } }] }
        : {}),
    });
    assert.equal(result.text, step.text);
    assert.equal(h.events.models.length, 0);
  }
});

void test("cancellation while reviewing a question releases neither text nor tools", async () => {
  const h = harness();
  await started(h);
  const pending = deferred();
  h.replies.push(() => pending.promise);
  const running = h.step(step);
  await new Promise((resolve) => setImmediate(resolve));
  h.unload();
  const result = await running;
  assert.deepEqual(result.chunks, []);
  assert.deepEqual(result.result.toolUses, []);
});

void test("question review criteria apply with custom prompts in both languages", async () => {
  for (const language of ["en", "ja"]) {
    const h = harness({ language, reviewPrompt: "CUSTOM" });
    await started(h);
    await h.step(step);
    const system = h.events.models[0]!.request.system;
    assert.match(system, /CUSTOM/u);
    assert.match(
      system,
      language === "ja" ? /判断できるだけの正確な情報/u : /enough accurate information to decide/u,
    );
    assert.match(system, language === "ja" ? /曖昧な表現/u : /ambiguous wording/u);
    assert.match(system, language === "ja" ? /プレビュー/u : /previews/u);
    assert.match(
      system,
      language === "ja" ? /過去ターンをすべて把握/u : /remembers all earlier turns/u,
    );
    assert.match(
      system,
      language === "ja" ? /各選択肢を選んだときの挙動の違い/u : /how behavior differs/u,
    );
    assert.match(
      system,
      language === "ja"
        ? /1つ目の選択肢が総合的な推奨案/u
        : /FIRST option must be the overall recommended/u,
    );
  }
});
