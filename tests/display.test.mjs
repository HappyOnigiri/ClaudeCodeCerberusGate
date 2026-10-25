import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../plugins/cerberus-gate-display/hooks/register.ts";

const control =
  'Cerberus Gate: 検証処理を継続します。 [1-1]\n\n指摘と根拠:\n- "fact.txt:1 contradicts the draft"';
let render;
register((event, matcher, handler) => {
  assert.equal(event, "ui.render");
  assert.deepEqual(matcher, { component: "UserMessage" });
  render = handler;
}, {});
const event = (props = {}, surface = "terminal") => ({
  component: "UserMessage",
  surface,
  requestId: "control-message",
  props: {
    text: `The cerberus-gate plugin sent a message:\n${control}\n\nAddress the message above.`,
    origin: { kind: "plugin", name: "cerberus-gate" },
    isExpanded: false,
    ...props,
  },
});

test("control body is collapsed without changing the message, then restored in the detailed view", () => {
  const input = event();
  const before = structuredClone(input);
  const original = { type: "Text", props: {}, children: [input.props.text] };
  const next = (e) => {
    assert.strictEqual(e, input);
    return original;
  };
  assert.deepEqual(render({}, input, next), { type: "Box", props: {}, children: [] });
  assert.deepEqual(input, before);
  input.props.isExpanded = true;
  assert.strictEqual(render({}, input, next), original);
  input.props.isExpanded = false;
  assert.deepEqual(render({}, input, next), { type: "Box", props: {}, children: [] });
});

test("user messages, other plugins, other Cerberus messages and remote surfaces keep their drawing", () => {
  for (const input of [
    event({ origin: { kind: "composer" } }),
    event({ origin: { kind: "plugin", name: "other" } }),
    event({ text: "Cerberus Gate: settings notice" }),
    event({ text: "Cerberus Gate: 検証処理を継続します。 [not-a-control]" }),
    event({}, "desktop"),
    event({}, "vscode"),
    event({}, "mobile"),
  ]) {
    const original = { type: "Text", props: {}, children: [input.props.text] };
    assert.strictEqual(
      render({}, input, (e) => {
        assert.strictEqual(e, input);
        return original;
      }),
      original,
    );
  }
});
