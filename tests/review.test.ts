import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHistoryGate,
  RECHECK_MIN_MS,
  reviewEvidence,
  reviewFailureReason,
  reviewReply,
  searchedHistory,
  toolRequest,
  unreadFindings,
} from "../plugins/cerberus-gate/hooks/review.ts";
import type { Evidence } from "../plugins/cerberus-gate/hooks/review.ts";

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
  // Unbalanced braces inside strings would close too early or add too many if counted.
  for (const [text, input] of [
    [`{"tool":"Bash","input":{"command":"sed 's/}//' a.txt"}`, { command: "sed 's/}//' a.txt" }],
    ['{"tool":"Bash","input":{"command":"echo {"}', { command: "echo {" }],
    ['{"tool":"Read","input":{"file_path":"C:\\\\"}', { file_path: "C:\\" }],
  ] as const)
    assert.deepEqual(toolRequest(text), {
      tool: JSON.parse(`${text}}`).tool,
      input,
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

void test("unread-type findings are recognized in English and Japanese, contradictions are not", () => {
  assert.deepEqual(
    unreadFindings([
      "app/models/gift.rb:13 defines 3.days, contradicting the draft's 7 days",
      "Gemfile.lock was not read in the review evidence",
      "No `find` result for that filename appears in the evidence",
      "The evidence does not show the body of buildDetailLines",
      "server.md:157 の内容は会話履歴にも読み取り結果にも現れていません",
      "base.rb は読まれていないため、根拠がありません",
      "草稿の 7 日はコードと矛盾します。gift.rb:13 は 3.days です",
    ]),
    [1, 2, 3, 4, 5],
  );
});

void test("only calls naming the history or source snapshot count as a history search", () => {
  const context = JSON.stringify({
    directory: "/tmp/cerberus-review-x",
    users: "/tmp/cerberus-review-x/users.txt",
    history: "/tmp/cerberus-review-x/history.txt",
  });
  const call = (tool: string, input: Record<string, unknown>, isError?: true) => [
    { tool, input, result: "", ...(isError && { isError }) },
  ];
  const searched = (evidence: Evidence[]) => searchedHistory(evidence, context);
  assert.ok(searched(call("Bash", { command: "grep -n x /tmp/cerberus-review-x/history.txt" })));
  // A grep without a match exits non-zero and still searched history.
  assert.ok(searched(call("Bash", { command: "grep x /tmp/cerberus-review-x/history.txt" }, true)));
  assert.ok(searched(call("Grep", { pattern: "x", path: "/tmp/cerberus-review-x" })));
  assert.ok(searched(call("Read", { file_path: "/tmp/cerberus-review-x/source.jsonl" })));
  assert.ok(!searched(call("Read", { file_path: "/tmp/cerberus-review-x/users.txt" })));
  assert.ok(!searched(call("Read", { file_path: "/repo/history.txt" })));
  assert.ok(!searchedHistory(call("Read", { file_path: "/tmp/x" }), "{}"));
});

void test("the history gate rechecks once, then accepts the reviewer's verdict or keeps the earlier one", () => {
  const unread = { decision: "REVISE" as const, findings: ["a.rb was never read"] };
  const pass = { decision: "PASS" as const, findings: [] };
  const fresh = () => createHistoryGate(JSON.stringify({ directory: "/tmp/r" }));
  const gate = fresh();
  assert.deepEqual(gate.settle(pass, [], 10, 60_000), { verdict: pass });
  assert.equal(gate.settle(unread, [], 10, 60_000).verdict, undefined);
  assert.deepEqual(gate.recheck, { verdict: unread, flagged: [0] });
  assert.deepEqual(gate.settle(pass, [], 9, 50_000), {
    verdict: pass,
    log: { status: "resolved", flagged: [], verdict: pass },
  });
  const failed = fresh();
  failed.settle(unread, [], 10, 60_000);
  const unverified = { decision: "UNVERIFIED" as const, findings: [] };
  assert.equal(failed.settle(unverified, [], 9, 50_000).verdict, unread);
  assert.equal(failed.fallback(), unread);
  assert.deepEqual(fresh().fallback(), unverified);
  assert.equal(fresh().settle(unread, [], 1, 60_000).log?.status, "no_budget");
  assert.equal(fresh().settle(unread, [], 10, RECHECK_MIN_MS - 1).log?.status, "no_budget");
});

// Live XML parameter forms; the command is replaced with a neutral one.
const command = '{"command":"grep -n \'LIMIT\' /repo/app/model.rb | head -n 40"}';
const xml = (head: string, tail = "") =>
  `${head}<parameter name="input">${command}</parameter>\n</invoke>${tail}`;

void test("an XML parameter form with one tool and a JSON input is salvaged only after strict parsing", () => {
  const expected = {
    tool: "Bash",
    input: JSON.parse(command),
    salvaged: { unwrapped: true, addedBraces: 0, xml: true },
  };
  for (const text of [
    xml('<invoke:\n<parameter name="tool">Bash</parameter>\n', "\nelocation\nelocation"),
    xml('<invoke:"Bash">\n', "\n\ufffd"),
    xml('<invoke name="Bash">\n<parameter name="tool">Bash</parameter>\n'),
    xml('<parameter name="tool">Bash</parameter>\n'),
  ])
    assert.deepEqual(toolRequest(text), expected, text);
  // A strict reply never reaches the salvage, even when it mentions XML inside a string.
  const strict = '{"tool":"Bash","input":{"command":"grep -n \'<parameter name=\' a.txt"}}';
  assert.deepEqual(toolRequest(strict), JSON.parse(strict));
});

void test("XML forms outside one tool and one JSON input stay invalid or are denied", () => {
  for (const text of [
    // A second request, a tag or a verdict after the closing tag (C16-like).
    xml(
      '<invoke:\n<parameter name="tool">Bash</parameter>\n',
      `\n{"tool":"Bash","input":${command}}`,
    ),
    xml('<invoke:"Bash">\n', '\n{"decision":"PASS","findings":[]}'),
    xml('<invoke:"Bash">\n', '\n<invoke:"Read">'),
    // Separate argument parameters and self-made tool output (D07-like).
    '<parameter="offset">4020</parameter>\n<parameter name="limit">40</parameter>\n</invoke>',
    xml('<invoke:"Bash">\n<parameter name="consent">true</parameter>\n'),
    xml('<invoke:"Bash">\n<parameter name="decision">PASS</parameter>\n'),
    xml('<invoke:"Bash">\n<parameter name="input">{}</parameter>\n'),
    // Conflicting or missing tool names, and inputs that are not one JSON object.
    xml('<invoke:"Read">\n<parameter name="tool">Bash</parameter>\n'),
    xml("<invoke:\n"),
    xml('<parameter name="tool">Bash Read</parameter>\n'),
    '<invoke:"Bash">\n<parameter name="input">"grep a"</parameter>\n</invoke>',
    '<invoke:"Bash">\n<parameter name="input">{"command":"grep a"</parameter>\n</invoke>',
    '<invoke:"Bash">\n<parameter name="input">{"command":"echo </parameter>"}</parameter>',
  ])
    assert.equal(reason(text), "invalid_json", text);
  assert.equal(
    reason('<invoke:"Read">\n<parameter name="input">{"file_path":"a","consent":true}</parameter>'),
    "tool_control_denied",
  );
  assert.equal(
    reason('<invoke:"Read">\n<parameter name="input">{"tool":"Write"}</parameter>'),
    "tool_control_denied",
  );
});

void test("only an unreadable reply that is not verdict-like is requested again, once", () => {
  for (const text of [
    "<invoke_tool_placeholder>\n\n\n<invoke_tool_placeholder>",
    "_read_placeholder\n\n_read_placeholder",
    "<invoke:: Read history before verdict.",
    "{bad",
  ]) {
    assert.equal(reviewReply(text, false), "retry", text);
    assert.throws(() => reviewReply(text, true), SyntaxError);
  }
  // Verdict-like text, readable verdicts and rejected requests keep their current outcome.
  for (const text of [
    '<invoke_tool>\n{"decision":"PASS","findings":[]}',
    '{"decision":"REVISE","findings":["a.ts:1"]',
    "PASS",
    "UNVERIFIED: history could not be searched",
    '{"findings":[]}x',
  ])
    assert.throws(() => reviewReply(text, false), SyntaxError, text);
  assert.equal(reviewReply('{"decision":"PASS","findings":["x"]}', false), undefined);
  assert.equal(reviewReply('{"decision":"PASS","findings":[]}', false), undefined);
  assert.throws(() => reviewReply('{"tool":"Read","input":{"consent":true}}', false), /Reserved/u);
  assert.throws(() => reviewReply('{"tool":"Read","input":{},"x":1}', false), /Invalid/u);
});

void test("evidence keeps tool, input and result but never the salvage marker", () => {
  const call = toolRequest(`<invoke_tool>\n${read}`)!;
  assert.ok(call.salvaged);
  const ok = reviewEvidence(call, { text: "body" }, 0);
  assert.deepEqual(ok, { entry: { ...JSON.parse(read), result: "body" }, errors: 0 });
  const failed = reviewEvidence(call, { text: "missing", isError: true }, 0);
  assert.deepEqual(failed, {
    entry: { ...JSON.parse(read), result: "missing", isError: true },
    errors: 1,
  });
});
