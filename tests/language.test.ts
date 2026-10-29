import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, correction } from "../plugins/cerberus-gate/hooks/policy.ts";
import { reviewModelRequest, reviewEvidence } from "../plugins/cerberus-gate/hooks/review.ts";
import { translate } from "../plugins/cerberus-gate/hooks/locale.ts";
import { createLog } from "../plugins/cerberus-gate/hooks/log.ts";
import { harness, started, verdict, history } from "./helpers/gate-harness.ts";

void test("language defaults to English, accepts Japanese and rejects invalid settings", () => {
  assert.equal(readConfig({}).language, "en");
  assert.equal(readConfig({ language: "ja" }).language, "ja");
  for (const language of [null, false, 1, {}, [], "", "fr", "JA"])
    assert.throws(() => readConfig({ language }), /Invalid language/u);
  assert.match(readConfig({}).reviewPrompt, /Verify material factual claims/u);
  assert.match(readConfig({ language: "ja", reviewPrompt: " \n " }).reviewPrompt, /重要な事実/u);
  for (const language of ["en", "ja"])
    assert.equal(
      readConfig({ language, reviewPrompt: "Custom\n審査基準" }).reviewPrompt,
      "Custom\n審査基準",
    );
});

for (const language of ["en", "ja"] as const) {
  void test(`${language}: review, retry and history recheck instructions keep the read-only JSON contract`, () => {
    const config = readConfig({ language });
    const request = reviewModelRequest(config, {
      model: "haiku",
      effort: "low",
      request: "original",
      workingDirectory: "/repo",
      candidate: { context: "{}", text: "draft" },
      tools: [],
      evidence: [],
      remaining: 1000,
      formatRetry: true,
      recheck: { verdict: { decision: "REVISE", findings: ["unread"] }, flagged: [0] },
    });
    const prompt = JSON.parse(request.prompt);
    assert.match(
      request.system,
      language === "ja" ? /副作用のない調査/u : /side-effect-free investigation/u,
    );
    assert.match(request.system, language === "ja" ? /書き込みは禁止/u : /Never modify files/u);
    assert.match(request.system, /"decision":"PASS"\|"REVISE"\|"UNVERIFIED"/u);
    assert.match(request.system, /sessionLog\.history/u);
    assert.match(request.system, language === "ja" ? /3回連続/u : /3 consecutive/u);
    assert.match(
      prompt.formatError,
      language === "ja" ? /何も実行していません/u : /nothing was run/u,
    );
    assert.match(prompt.replyFormat, language === "ja" ? /返してください/u : /Return exactly/u);
    assert.match(
      prompt.historyRecheck.instruction,
      language === "ja" ? /受理されませんでした/u : /NOT accepted/u,
    );
    if (language === "en")
      assert.doesNotMatch(request.system + request.prompt, /[ぁ-んァ-ン一-龥]/u);
    const background = reviewEvidence(
      { tool: "Bash", input: {} },
      { result: { backgroundTaskId: "task" } },
      0,
      language,
    );
    assert.ok("entry" in background);
    assert.match(
      background.entry.result,
      language === "ja" ? /あなたのコマンドを停止/u : /stopped YOUR command/u,
    );
    assert.equal(background.entry.isError, true);
  });

  void test(`${language}: configured UI, logs and correction prompts use the same language`, async () => {
    const h = harness({ language });
    await started(h);
    h.replies.push(verdict("REVISE", ["fact.txt:1 contradicts the draft"]));
    await h.step();
    assert.equal(h.events.notes.at(-1), translate(language, "revising", 1));
    assert.ok(h.events.statuses.includes(translate(language, "waiting")));
    await h.flushCorrections();
    assert.ok(h.events.prompts[0]!.text.startsWith(translate(language, "control")));
    assert.match(
      h.events.prompts[0]!.context.join("\n"),
      language === "ja" ? /ユーザーには表示されていません/u : /NOT shown to the user/u,
    );
    assert.match(
      await history(h),
      language === "ja" ? /審査 #\d+: REVISE/u : /Review #\d+: REVISE/u,
    );
    assert.match(
      (await h.fire("command.run", { command: "cgate", args: "" })).text,
      language === "ja" ? /修正回数=1/u : /corrections=1/u,
    );
    await h.fire("command.run", { command: "cgate", args: "off" });
    const pane = await h.fire("ui.render", {
      component: "Pane",
      requestId: "enabled-scope",
      surface: "terminal",
    });
    assert.equal(pane.options[0]!.value, "session");
    assert.equal(Reflect.get(pane.options[0]!, "label"), translate(language, "sessionScope"));
    h.replies.push(verdict());
    assert.equal((await h.step()).notes.at(-1), translate(language, "passed"));
  });
}

void test("Japanese logs localize headers, omitted rows, time failures and findings without changing evidence", async () => {
  const log = createLog(() => "ja");
  assert.match(await log.text(), /ログはありません/u);
  for (let i = 0; i < 1001; i++) log.record(Promise.resolve(0), "event");
  log.record(Promise.reject(new Error("secret")), "審査", ["source:1\nquoted"]);
  const text = await log.text();
  assert.match(text, /古い 2 件を省略/u);
  assert.match(text, /時刻不明/u);
  assert.match(text, /指摘と根拠:/u);
  assert.ok(text.includes(JSON.stringify("source:1\nquoted")));
  assert.doesNotMatch(text, /secret/u);
  assert.match(correction("draft", [], "ja"), /既に与えられた権限/u);
});

void test("reload uses the selected language for restart controls and context", async () => {
  const h = harness();
  await started(h);
  h.replies.push(verdict("REVISE", ["source:1 contradicts the draft"]));
  await h.step();
  h.unload();
  const next = harness({ language: "ja" }, "2.1.310", h.host);
  await next.fire("session.start", { isInteractive: true });
  await next.flushCorrections();
  assert.ok(next.events.prompts[0]!.text.startsWith(translate("ja", "control")));
  assert.match(next.events.prompts[0]!.context.join("\n"), /プラグインの再ロード/u);
  assert.match(next.events.prompts[0]!.context.join("\n"), /original request/u);
  assert.doesNotMatch(next.events.prompts[0]!.context.join("\n"), /UNPUBLISHED DRAFT/u);
  assert.match(
    (await next.fire("command.run", { command: "cgate", args: "log" })).text,
    /デバッグログ/u,
  );
});
