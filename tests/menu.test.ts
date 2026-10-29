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
