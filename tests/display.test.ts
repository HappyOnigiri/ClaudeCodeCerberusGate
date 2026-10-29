import { asFixture } from "./helpers/fixture.ts";
import type { On } from "claude-code";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../plugins/cerberus-gate-display/hooks/register.ts";

const control =
  'Cerberus Gate: 検証処理を継続します。 [1-1]\n\n指摘と根拠:\n- "fact.txt:1 contradicts the draft"';
let render!: (
  engine: object,
  input: ReturnType<typeof event>,
  next: (input: ReturnType<typeof event>) => unknown,
) => unknown;
register(
  asFixture<On>((event: string, matcher: unknown, handler: typeof render) => {
    assert.equal(event, "ui.render");
    assert.deepEqual(matcher, { component: "UserMessage" });
    render = handler;
  }),
  {},
);
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

void test("control body is collapsed without changing the message, then restored in the detailed view", () => {
  const input = event();
  const before = structuredClone(input);
  const original = { type: "Text", props: {}, children: [input.props.text] };
  const next = (e: ReturnType<typeof event>) => {
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

void test("user messages, other plugins, other Cerberus messages and remote surfaces keep their drawing", () => {
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
      render({}, input, (e: ReturnType<typeof event>) => {
        assert.strictEqual(e, input);
        return original;
      }),
      original,
    );
  }
});

void test("English control messages collapse and expand with the same origin boundary", () => {
  const input = event({
    text: 'Cerberus Gate: Continuing answer verification. [1-2]\n\nFindings and evidence:\n- "source:1"',
  });
  const original = { type: "Text", props: {}, children: [input.props.text] };
  assert.deepEqual(
    render({}, input, () => original),
    { type: "Box", props: {}, children: [] },
  );
  input.props.isExpanded = true;
  assert.strictEqual(
    render({}, input, () => original),
    original,
  );
  input.props.isExpanded = false;
  input.props.origin.name = "other";
  assert.strictEqual(
    render({}, input, () => original),
    original,
  );
});
