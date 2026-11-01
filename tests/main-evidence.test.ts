import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMainEvidence,
  observeMainCall,
  mainEvidenceText,
  MAX_MAIN_EVIDENCE,
} from "../plugins/cerberus-gate/hooks/main-evidence.ts";
import { harness, started, deferred, verdict, tick } from "./helpers/gate-harness.ts";
import { UNVERIFIED } from "../plugins/cerberus-gate/hooks/policy.ts";

void test("completed main evidence snapshots exact inputs, successes and errors", () => {
  const evidence = createMainEvidence();
  const input = { tool: "Read", file_path: "fact.txt" };
  const result = { text: "release=stable", isError: false };
  observeMainCall(evidence, input, result);
  input.file_path = "changed";
  result.text = "changed";
  observeMainCall(evidence, { tool: "Read" }, { isError: true, text: "missing" });
  observeMainCall(evidence, { tool: "Read" }, { deny: "permission" });
  assert.deepEqual(JSON.parse(mainEvidenceText(evidence)), [
    {
      tool: "Read",
      input: { tool: "Read", file_path: "fact.txt" },
      result: { text: "release=stable", isError: false },
    },
    { tool: "Read", input: { tool: "Read" }, result: { isError: true, text: "missing" } },
    { tool: "Read", input: { tool: "Read" }, result: { deny: "permission" } },
  ]);
});
void test("budget and serialization failures never silently truncate or drop earlier evidence", () => {
  const evidence = createMainEvidence();
  const input = { tool: "Read" };
  const overhead = JSON.stringify([{ tool: "Read", input, result: "" }]).length;
  observeMainCall(evidence, input, "x".repeat(MAX_MAIN_EVIDENCE - overhead));
  assert.equal(evidence.chars, MAX_MAIN_EVIDENCE);
  assert.equal(mainEvidenceText(evidence).length, MAX_MAIN_EVIDENCE);
  assert.equal(evidence.incomplete, false);
  const before = mainEvidenceText(evidence);
  observeMainCall(evidence, input, "next");
  assert.equal(evidence.incomplete, true);
  assert.equal(mainEvidenceText(evidence), before);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const failed = createMainEvidence();
  observeMainCall(failed, input, circular);
  assert.equal(failed.incomplete, true);
});
void test("fork receives observed main calls across corrections but not across user requests", async () => {
  const h = harness({ reviewerModel: "inherit" });
  await started(h);
  h.setCall({ text: "SOURCE stable" });
  await h.fire("tool.call", { tool: "Read", file_path: "fact.txt" });
  h.replies.push(verdict("REVISE", ["correct the claim"]), verdict());
  await h.step();
  await h.flushCorrections();
  await h.step();
  for (const request of h.events.forks) assert.match(request.prompt, /SOURCE stable/u);
  await h.prompt("new task");
  await h.step();
  assert.doesNotMatch(h.events.forks.at(-1)!.prompt, /SOURCE stable/u);
  assert.deepEqual(h.events.materialRequests, []);
  assert.deepEqual(h.events.models, []);
});
void test("fork excludes subagents, reviewer calls and results finishing after a new request", async () => {
  const h = harness({ reviewerModel: "inherit" });
  await started(h);
  h.setCall({ text: "SUBAGENT evidence" });
  await h.fire("tool.call", { tool: "Read", agentId: "other" });
  const late = deferred();
  h.setCall(() => late.promise);
  const running = h.fire("tool.call", { tool: "Read" });
  await tick();
  await h.prompt("new task");
  late.resolve({ text: "OLD evidence" });
  await running;
  await h.step();
  assert.doesNotMatch(h.events.forks[0]!.prompt, /SUBAGENT evidence|OLD evidence/u);
});
void test("incomplete evidence is UNVERIFIED without starting fork or falling back", async () => {
  const h = harness({ reviewerModel: "inherit" });
  await started(h);
  h.setCall({ text: "x".repeat(MAX_MAIN_EVIDENCE) });
  await h.fire("tool.call", { tool: "Read" });
  const result = await h.step();
  assert.deepEqual(result.notes, [UNVERIFIED]);
  assert.equal(h.events.forks.length, 0);
  assert.equal(h.events.models.length, 0);
  assert.equal(h.events.prompts.length, 0);
  assert.ok(h.events.debug.some((entry) => entry.data.reason === "main_evidence_incomplete"));
});

void test("current draft follows old findings and evidence, with the verdict contract last", async () => {
  const { forkPrompt } = await import("../plugins/cerberus-gate/hooks/fork-prompt.ts");
  const { readConfig } = await import("../plugins/cerberus-gate/hooks/policy.ts");
  for (const language of ["en", "ja"]) {
    const prompt = forkPrompt(
      readConfig({ language }),
      "request",
      "stable",
      ["old beta"],
      '[{"result":"source"}]',
    );
    assert.ok(prompt.indexOf('"unpublishedDraft":"stable"') > prompt.indexOf("old beta"));
    assert.ok(prompt.indexOf('"unpublishedDraft":"stable"') > prompt.indexOf('"result":"source"'));
    assert.match(prompt.slice(prompt.lastIndexOf("\n") + 1), /PASS.*REVISE.*UNVERIFIED/u);
  }
});
