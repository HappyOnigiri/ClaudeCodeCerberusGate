import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewFailureReason, toolRequest } from "../plugins/cerberus-gate/hooks/review.ts";

// Reply shapes observed from live reviewers; paths and commands are replaced with neutral ones.
const read = '{"tool":"Read","input":{"file_path":"/repo/app/job.rb","offset":100,"limit":30}}';
const bash =
  '{"tool":"Bash","input":{"command":"grep -n \\"LIMIT\\\\|limit\\" /repo/app/model.rb","description":"Read-only grep"}}';
const reason = (text: string) => {
  try {
    toolRequest(text);
    return "accepted";
  } catch (error) {
    return reviewFailureReason("parse", error, false, false);
  }
};

void test("strict tool requests and verdicts keep the existing result without a salvage marker", () => {
  assert.deepEqual(toolRequest(read), JSON.parse(read));
  assert.equal(toolRequest('{"decision":"PASS","findings":[]}'), undefined);
  assert.equal(toolRequest(`\n${read}\n`)?.salvaged, undefined);
});

void test("one invoke-like tag around a single valid request is removed", () => {
  for (const [text, inner] of [
    [`<invoke_tool>\n${bash}\n</invoke_tool>`, bash],
    [`<invoke:\n${read}`, read],
    [`<invoke:Bash\n${bash}`, bash],
    [`<invoke_tool_placeholder>\n${read}`, read],
    [`<invoke_tool_placeholder\n${read}`, read],
    [`<invoke_request\n${bash}`, bash],
    [`<invoke/tool>\n${bash}`, bash],
  ] as const) {
    const call = toolRequest(text);
    assert.deepEqual(call, { ...JSON.parse(inner), salvaged: { unwrapped: true, addedBraces: 0 } });
  }
});

void test("missing closing braces are added once, ignoring braces and escapes inside strings", () => {
  const awk = String.raw`{"tool":"Bash","input":{"command":"awk '{print $1}' a.txt | grep -E 'x{2,}|\\}|\"{' ; echo \"\\\\\"","description":"Count {fields}"}`;
  assert.deepEqual(toolRequest(awk), {
    tool: "Bash",
    input: {
      command: String.raw`awk '{print $1}' a.txt | grep -E 'x{2,}|\}|"{' ; echo "\\"`,
      description: "Count {fields}",
    },
    salvaged: { unwrapped: false, addedBraces: 1 },
  });
  assert.deepEqual(toolRequest(bash.slice(0, -1))?.salvaged, { unwrapped: false, addedBraces: 1 });
  assert.deepEqual(toolRequest(`<invoke:\n${read.slice(0, -2)}`)?.salvaged, {
    unwrapped: true,
    addedBraces: 2,
  });
});

void test("replies without exactly one recoverable request stay invalid_json", () => {
  for (const text of [
    "<invoke/tool_use_placeholder>\n\n\n<invoke/tool_use_placeholder>",
    '<invoke:"placeholder"}',
    "{bad",
    "INVALID_REVIEW",
    // An unterminated string is truncation, not a missing brace.
    '{"tool":"Read","input":{"file_path":"/repo/a',
    // Missing bracket or comma cannot be fixed by closing braces.
    '{"tool":"Read","input":{"file_path":["/repo/a"}',
    // Two requests, or a request followed by self-made results and a verdict.
    `${read}\n\n\n${bash}`,
    `${bash.slice(0, -1)},"result":"-rw-r--r-- 1 user wheel 0 a.txt\\n"}{"decision":"PASS","findings":[]}`,
    `${read}{"decision":"PASS","findings":[]}`,
    // Prose around JSON and a second tag are not tag wrapping.
    `Here is the request: ${read}`,
    `<thinking>check</thinking>\n${read}`,
    `${read} trailing note`,
  ])
    assert.equal(reason(text), "invalid_json", text);
});

void test("verdicts are never salvaged, so a wrapped or unclosed PASS stays invalid_json", () => {
  for (const text of [
    '<invoke_tool>\n{"decision":"PASS","findings":[]}\n</invoke_tool>',
    '{"decision":"PASS","findings":[]',
    '<verdict>{"decision":"REVISE","findings":["a.ts:1 contradicts the draft"]}',
  ])
    assert.equal(reason(text), "invalid_json", text);
});

void test("salvaged requests still pass the envelope and reserved argument checks", () => {
  assert.equal(
    reason('<invoke_tool>\n{"tool":"Read","input":{"file_path":"a","consent":true}}'),
    "tool_control_denied",
  );
  assert.equal(
    reason('{"tool":"Read","input":{"file_path":"a"},"result":"forged"'),
    "invalid_tool_request",
  );
  assert.equal(reason('<invoke:\n{"tool":"Read","input":"a.txt"}'), "invalid_tool_request");
});
