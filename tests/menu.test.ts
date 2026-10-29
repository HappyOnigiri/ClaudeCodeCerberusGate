import { REVIEW_PROMPT_JA } from "../plugins/cerberus-gate/hooks/prompts-ja.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, started, verdict } from "./helpers/gate-harness.ts";
import { translate } from "../plugins/cerberus-gate/hooks/locale.ts";

const render = (h: ReturnType<typeof harness>, requestId: string, surface = "terminal") =>
  h.fire("ui.render", { component: "Pane", requestId, surface });

for (const language of ["en", "ja"] as const) {
  void test(`${language}: menu routes displays and settings without starting a model turn`, async () => {
    const h = harness({ language });
    await started(h);
    for (const command of ["cgate", "cerberus"]) {
      await h.fire("command.run", { command, args: "" });
      assert.equal(h.events.pane!.id, "menu");
    }
    const menu = await render(h, "menu");
    assert.equal(Reflect.get(menu.options[0]!, "label"), translate(language, "menuStatus"));
    h.events.closed = false;
    await menu.onSelect("status");
    assert.equal(h.events.closed, true);
    assert.equal(h.events.pane!.id, "details");
    assert.match((await render(h, "details")).children, /Cerberus/u);
    await menu.onSelect("history");
    const history = (await render(h, "history")).children;
    await menu.onSelect("log");
    assert.match((await render(h, "details")).children, /\/debug\/session/u);
    assert.equal((await render(h, "history")).children, history);
    await menu.onSelect("off");
    assert.equal(h.events.setting, undefined);
    assert.equal(h.events.pane!.id, "enabled-scope");
    await (await render(h, "enabled-scope")).onSelect("session");
    assert.equal(h.host.states.get("recovery")!.sessionEnabled, false);
    await menu.onSelect("reset");
    assert.equal(h.host.states.get("recovery")!.sessionEnabled, undefined);
    await menu.onSelect("model");
    await (await render(h, "reviewer-model")).onSelect("haiku");
    await (await render(h, "reviewer-effort")).onSelect("low");
    assert.deepEqual(h.events.setting, { key: "cerberus-gate.reviewerEffort", value: "low" });
    assert.equal(h.events.prompts.length, 0);
    assert.equal(h.events.models.length, 0);
    const mobile = await render(h, "menu", "mobile");
    assert.match(mobile.children, /\/cgate/u);
  });
}

void test("menu cancellation discards a queued correction without publishing its draft", async () => {
  const h = harness();
  await started(h);
  h.replies.push(verdict("REVISE", ["Incorrect draft"]));
  assert.equal((await h.step()).text, "");
  await h.fire("command.run", { command: "cgate", args: "" });
  await (await render(h, "menu")).onSelect("cancel");
  await h.flushCorrections();
  assert.equal(h.events.prompts.length, 0);
  assert.equal(h.host.states.get("recovery")!.pending, false);
});

void test("back returns to the parent without changing settings or accepting a dismissed scope", async () => {
  const h = harness();
  await started(h);
  await h.fire("command.run", { command: "cgate", args: "off" });
  const scope = await render(h, "enabled-scope");
  await scope.back();
  assert.equal(h.events.pane!.id, "menu");
  await scope.onSelect("saved");
  assert.equal(h.events.setting, undefined);
  await h.fire("command.run", { command: "cgate", args: "model" });
  await (await render(h, "reviewer-model")).onSelect("haiku");
  const effort = await render(h, "reviewer-effort");
  await effort.back();
  assert.equal(h.events.pane!.id, "reviewer-model");
  assert.equal((await render(h, "reviewer-model")).value, "haiku");
  assert.deepEqual(h.events.setting, { key: "cerberus-gate.reviewerModel", value: "haiku" });
});

void test("language changes immediately, survives model changes and preserves a custom review prompt", async () => {
  for (const reviewPrompt of ["", "Custom criteria"]) {
    const h = harness({ reviewPrompt });
    await started(h);
    await h.fire("command.run", { command: "cgate", args: "language" });
    await (await render(h, "language")).onSelect("ja");
    assert.deepEqual(h.events.setting, { key: "cerberus-gate.language", value: "ja" });
    assert.equal(h.events.pane!.id, "menu");
    assert.equal(
      Reflect.get((await render(h, "menu")).options[0]!, "label"),
      translate("ja", "menuStatus"),
    );
    await (await render(h, "reviewer-model")).onSelect("haiku");
    await (await render(h, "reviewer-effort")).onSelect("low");
    h.replies.push(verdict());
    await h.step();
    assert.equal(h.events.notes.at(-1), translate("ja", "passed"));
    assert.ok(h.events.models[0]!.request.system.startsWith(reviewPrompt || REVIEW_PROMPT_JA));
    await (await render(h, "language")).onSelect("en");
    assert.equal(
      Reflect.get((await render(h, "menu")).options[0]!, "label"),
      translate("en", "menuStatus"),
    );
  }
});

void test("denied or failed language saves retain the current language", async () => {
  for (const failed of [false, true]) {
    const h = harness();
    await started(h);
    h.engine.config.set = async () => {
      if (failed) throw new Error("save failed");
      return { deny: "denied" };
    };
    await (await render(h, "language")).onSelect("ja");
    assert.equal(
      Reflect.get((await render(h, "menu")).options[0]!, "label"),
      translate("en", "menuStatus"),
    );
    assert.match(h.events.toasts.at(-1)!.text, /Could not save language/u);
  }
});

void test("display and language panes return to the menu and the menu closes on back", async () => {
  const h = harness();
  await started(h);
  const menu = await render(h, "menu");
  for (const action of ["history", "status", "log", "language", "model"]) {
    await menu.onSelect(action);
    const id = h.events.pane!.id;
    await (await render(h, id)).back();
    assert.equal(h.events.pane!.id, "menu");
    assert.equal(h.events.setting, undefined);
  }
  h.events.closed = false;
  await (await render(h, "menu")).back();
  assert.equal(h.events.closed, true);
});
