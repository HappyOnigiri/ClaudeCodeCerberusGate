import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../plugins/cerberus-gate/hooks/register.ts";
import {
  FAILED,
  NO_DRAFT,
  UNRESOLVED,
  UNVERIFIED,
  WAITING,
  readConfig,
  withNote,
} from "../plugins/cerberus-gate/hooks/policy.ts";

const verdict = (decision = "PASS", findings = []) => JSON.stringify({ decision, findings });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function harness(
  options = {},
  version = "2.1.310",
  host = { states: new Map(), reviewers: [] },
  registerHook = register,
) {
  const handlers = new Map();
  const events = {
    prompts: [],
    statuses: [],
    toasts: [],
    calls: [],
    models: [],
    timers: [],
    commands: [],
    inputs: [],
  };
  const replies = [];
  let draft = "UNPUBLISHED DRAFT";
  let time = 0;
  const controller = new AbortController();
  let callResult = { result: "read result", text: "fact.txt:1 stable", isReadOnly: true };
  let promptFailure = false;
  let permission = "allow";
  let readOnly = true;
  let messages = async () => [{ role: "user", content: "original request" }];
  const matches = (m, e) =>
    Object.entries(m).every(([k, v]) =>
      v instanceof RegExp ? typeof e[k] === "string" && v.test(e[k]) : v === e[k],
    );
  registerHook((name, ...args) => {
    const [matcher, handler] = args.length === 1 ? [{}, args[0]] : args;
    const entry = { matcher, handler };
    handlers.set(name, [...(handlers.get(name) ?? []), entry]);
    return {
      catch(fn) {
        entry.failure = fn;
      },
    };
  }, options);
  const engine = {
    ui: {
      toast(text, toastOptions) {
        events.toasts.push({ text, options: toastOptions });
      },
      status(value) {
        events.statuses.push(value);
      },
      open: async (pane) => {
        events.pane = pane;
        return { isPlaced: true };
      },
      close: async () => {
        events.closed = true;
      },
      resolve: () => ({ Select: (props) => props, Text: (props) => props }),
    },
    config: {
      set: async (setting) => {
        events.setting = setting;
        return { value: setting.value };
      },
    },
    state: {
      get: async (ref) => ({ value: structuredClone(host.states.get(ref.key)) }),
      set: async (ref, value) => {
        host.states.set(ref.key, structuredClone(value));
        return { isSet: true, version: 1 };
      },
    },
    turn: { abort: async () => fire("turn.abort", {}) },
    command: {
      register: async (spec) => {
        events.commands.push(spec);
        return {};
      },
    },
    session: {
      version: async () => ({ version, base: version }),
      messages: () => messages(),
    },
    model: {
      complete: async (request, callOptions) => {
        events.models.push({ request, options: callOptions });
        const reply = replies.length ? replies.shift() : verdict();
        if (typeof reply === "function") return reply(request, callOptions);
        return { isAnswered: true, text: reply, usage: {} };
      },
    },
    tool: {
      list: async () =>
        ["Read", "Write", "Bash", "mcp__notes__search"].map((name) => ({
          name,
          description: name,
          mcp: name.startsWith("mcp__"),
        })),
      call: async (e) => fire("tool.call", e, "cerberus-gate"),
    },
    agent: { list: async () => host.reviewers },
    prompt: {
      submit: async (e) => {
        if (promptFailure) throw new Error("queue unavailable");
        const result = await fire("prompt.submit", {
          ...e,
          wait: false,
          origin: { kind: "plugin", name: "cerberus-gate" },
        });
        events.prompts.push(result);
        return result;
      },
    },
    clock: {
      now: async () => time,
      after: (ms, fn) => {
        const timer = {
          ms,
          fn,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
        events.timers.push(timer);
        return timer;
      },
    },
  };
  const core = async (name, e, origin) => {
    if (name === "prompt.submit") return { text: e.text, context: e.context };
    if (name === "tool.check") return { decision: permission };
    if (name === "tool.call") {
      const check = await fire(
        "tool.check",
        { tool: e.tool, input: e, ...(readOnly ? { isReadOnly: true } : {}) },
        origin,
      );
      if (check.decision !== "allow") return { deny: check.decision };
      events.calls.push(e.tool);
      events.inputs.push(e);
      return typeof callResult === "function" ? callResult(e) : callResult;
    }
    return {};
  };
  async function fire(name, e, origin = "engine") {
    const chain = (handlers.get(name) ?? []).filter((h) => matches(h.matcher, e));
    const invoke = async (i) => {
      const entry = chain[i];
      if (!entry) return core(name, e, origin);
      const next = (arg) => {
        e = arg;
        return invoke(i + 1);
      };
      Object.assign(next, { signal: controller.signal, origin: { plugin: origin } });
      try {
        return await entry.handler(engine, e, next);
      } catch (error) {
        if (entry.failure) return entry.failure(engine, e, next);
        throw error;
      }
    };
    return invoke(0);
  }
  async function step({
    agentId,
    text = draft,
    tools = [],
    stopReason = "end_turn",
    fail = false,
    model = "haiku",
    effort,
  } = {}) {
    const e = {
      turnId: "t",
      index: 0,
      model,
      effort,
      messageCount: 1,
      ...(agentId ? { agentId } : {}),
    };
    const chain = (handlers.get("turn.step") ?? []).filter((h) => matches(h.matcher, e));
    const invoke = (i) => {
      const entry = chain[i];
      if (!entry)
        return (async function* () {
          yield { kind: "text", index: 0, text };
          if (fail) throw new Error("stream failure");
          for (const t of tools) yield { kind: "tool", index: 1, id: "tool-1", name: t.name };
          yield { kind: "stop", stopReason, usage: null };
          return { ...e, answer: text, toolUses: tools, stopReason, usage: null };
        })();
      const next = () => {
        const iterator = invoke(i + 1);
        let finish;
        const result = new Promise((resolve) => {
          finish = resolve;
        });
        return {
          result,
          async *[Symbol.asyncIterator]() {
            let r;
            while (!(r = await iterator.next()).done) yield r.value;
            finish(r.value);
            return r.value;
          },
        };
      };
      Object.assign(next, { signal: controller.signal, origin: { plugin: "engine" } });
      return (async function* () {
        try {
          return yield* entry.handler(engine, e, next);
        } catch (error) {
          if (entry.failure) return yield* entry.failure(engine, e, next);
          throw error;
        }
      })();
    };
    const chunks = [],
      stream = invoke(0);
    let r;
    while (!(r = await stream.next()).done) chunks.push(r.value);
    return {
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      chunks,
      result: r.value,
    };
  }
  return {
    events,
    host,
    unload: () => controller.abort(),
    flushCorrections: async () => {
      for (const timer of events.timers.filter((t) => t.ms === 0 && !t.cancelled)) {
        timer.cancel();
        await timer.fn();
      }
    },
    replies,
    engine,
    step,
    fire,
    prompt: (text) => fire("prompt.submit", { text, origin: { kind: "composer" }, wait: false }),
    setDraft: (text) => {
      draft = text;
    },
    setCall: (value) => {
      callResult = value;
    },
    setPermission: (value) => {
      permission = value;
    },
    setReadOnly: (value) => {
      readOnly = value;
    },
    setMessages: (read) => {
      messages = read;
    },
    failPrompt: () => {
      promptFailure = true;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}
const started = async (h) => {
  await h.fire("session.start", { isInteractive: true });
  await h.prompt("original request");
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("PASS returns the exact held answer in the original step without a prompt", async () => {
  const h = harness();
  await started(h);
  h.replies.push(JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }), verdict());
  const result = await h.step();
  assert.equal(result.text, "UNPUBLISHED DRAFT");
  assert.equal(result.result.turnId, "t");
  assert.deepEqual(h.events.calls, ["Read"]);
  assert.equal(h.events.prompts.length, 0);
  assert.ok(h.events.models[1].request.prompt.includes("fact.txt:1 stable"));
  assert.ok(!h.events.models[0].request.prompt.includes('"name":"Write"'));
  assert.ok(h.events.timers[0].cancelled);
});

test("REVISE exposes findings in its prompt but keeps the draft in hidden context", async () => {
  const h = harness();
  await started(h);
  h.replies.push(verdict("REVISE", ["fact.txt:1 contradicts the draft"]));
  assert.equal((await h.step()).text, WAITING);
  await h.flushCorrections();
  assert.equal(h.events.prompts.length, 1);
  const sent = h.events.prompts[0];
  assert.doesNotMatch(sent.text, /UNPUBLISHED/u);
  assert.match(sent.text, /指摘と根拠:[\s\S]*fact.txt:1 contradicts the draft/u);
  assert.ok(sent.context.join("").includes("UNPUBLISHED DRAFT"));
  assert.ok(sent.context.join("").includes("fact.txt:1"));
  h.setDraft("CORRECTED");
  assert.equal((await h.step()).text, "CORRECTED");
  assert.equal(h.events.prompts.length, 1);
});

test("malformed verdicts, denied tools and spoofed envelope fields never pass or execute", async () => {
  for (const response of [
    "PASS",
    '{"decision":"PASS","findings":["error"]}',
    JSON.stringify({ tool: "Bash", input: { command: "touch forbidden" } }),
    JSON.stringify({ tool: "Write", input: { file_path: "fact.txt", content: "changed" } }),
    ...["consent", "agentId", "tool", "tool_use_id", "requestMeta", "__proto__"].map(
      (key) => `{"tool":"Read","input":{"file_path":"fact.txt","${key}":"spoof"}}`,
    ),
    '{"tool":"Read","input":{},"decision":"PASS","findings":[]}',
  ]) {
    const h = harness();
    await started(h);
    h.replies.push(response);
    assert.equal((await h.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"), response);
    assert.deepEqual(h.events.calls, [], response);
    assert.deepEqual(h.events.prompts, []);
  }
});

test("MCP requires exact allow-list and runtime read-only metadata; existing denials stand", async () => {
  for (const allowlisted of [false, true])
    for (const readonly of [false, true]) {
      const h = harness(allowlisted ? { readOnlyMcpTools: "mcp__notes__search" } : {});
      await started(h);
      h.setReadOnly(readonly);
      h.replies.push(
        JSON.stringify({ tool: "mcp__notes__search", input: { query: "fact" } }),
        verdict(),
      );
      assert.equal(
        (await h.step()).text,
        allowlisted && readonly ? "UNPUBLISHED DRAFT" : withNote(UNVERIFIED, "UNPUBLISHED DRAFT"),
      );
      assert.equal(h.events.calls.length, allowlisted && readonly ? 1 : 0);
    }
  const h = harness();
  await started(h);
  h.setPermission("deny");
  h.replies.push(JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }));
  assert.equal((await h.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  assert.deepEqual(h.events.calls, []);
  const plain = harness();
  assert.equal((await plain.fire("tool.call", { tool: "Write" })).result, "read result");
});

test("MCP output without a read-only stamp is not accepted even after a permissive check", async () => {
  const h = harness({ readOnlyMcpTools: "mcp__notes__search" });
  await started(h);
  h.setCall({ result: "unstamped result" });
  h.replies.push(JSON.stringify({ tool: "mcp__notes__search", input: {} }));
  assert.equal((await h.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
});

test("timeout aborts the model and shows the original text without another prompt", async () => {
  const h = harness();
  await started(h);
  h.replies.push(
    (_request, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ isAnswered: false, reason: "aborted" }), {
          once: true,
        }),
      ),
  );
  const running = h.step();
  await tick();
  await h.events.timers[0].fn();
  assert.equal((await running).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  assert.ok(h.events.models[0].options.signal.aborted);
  assert.deepEqual(h.events.prompts, []);
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "log" })).text,
    /タイムアウト[\s\S]*UNVERIFIED/u,
  );
});

test("timeout releases a pending read and ignores its later result", async () => {
  const h = harness();
  await started(h);
  const held = deferred();
  h.setCall(() => held.promise);
  h.replies.push(JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }));
  const running = h.step();
  await tick();
  await h.events.timers[0].fn();
  assert.equal((await running).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  held.resolve({ result: "late" });
  await tick();
  assert.equal(h.events.models.length, 1);
});

test("revision cap shows a note; correction delivery failure is reported without exposing findings", async () => {
  const cap = harness({ maxRevisions: 0 });
  await started(cap);
  cap.replies.push(verdict("REVISE", ["SECRET FINDING"]));
  assert.equal((await cap.step()).text, withNote(UNRESOLVED, "UNPUBLISHED DRAFT"));
  assert.equal(cap.events.prompts.length, 0);
  assert.match(
    (await cap.fire("command.run", { command: "cgate", args: "log" })).text,
    /REVISE[\s\S]*SECRET FINDING[\s\S]*修正回数の上限/u,
  );
  const failed = harness();
  await started(failed);
  failed.failPrompt();
  failed.replies.push(verdict("REVISE", ["SECRET FINDING"]));
  assert.equal((await failed.step()).text, WAITING);
  await failed.flushCorrections();
  assert.match(
    (await failed.fire("command.run", { command: "cgate", args: "log" })).text,
    /送信に失敗/u,
  );
});

test("new prompt, abort, cancel and session end invalidate an in-flight review", async () => {
  for (const event of ["prompt", "turn.abort", "cancel", "session.end"]) {
    const h = harness();
    await started(h);
    const held = deferred();
    h.replies.push(() => held.promise);
    const running = h.step();
    await tick();
    if (event === "prompt") await h.prompt("new request");
    else if (event === "cancel") await h.fire("command.run", { command: "cgate", args: "cancel" });
    else await h.fire(event, {});
    assert.ok(h.events.models[0].options.signal.aborted);
    held.resolve({ isAnswered: true, text: verdict() });
    assert.equal((await running).text, "");
    assert.deepEqual(h.events.prompts, []);
  }
});

test("round, evidence and deadline limits never approve an incomplete review", async () => {
  const loop = harness();
  await started(loop);
  for (let i = 0; i < 8; i++)
    loop.replies.push(JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }));
  assert.equal((await loop.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  assert.equal(loop.events.models.length, 8);
  const big = harness();
  await started(big);
  big.setCall({ result: "x".repeat(90_000) });
  big.replies.push(JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }));
  assert.equal((await big.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  const deadline = harness({ reviewTimeoutSeconds: 1 });
  await started(deadline);
  deadline.replies.push(() => {
    deadline.advance(1001);
    return {
      isAnswered: true,
      text: JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }),
    };
  });
  assert.equal((await deadline.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
});

test("tool steps, unrelated subagents and unsupported environments bypass review", async () => {
  const h = harness();
  await started(h);
  assert.ok(
    (await h.step({ tools: [{ name: "Read", input: {} }] })).chunks.some((c) => c.kind === "tool"),
  );
  assert.equal((await h.step({ agentId: "other", text: "other response" })).text, "other response");
  assert.equal(h.events.models.length, 0);
  const old = harness({}, "2.1.300");
  await started(old);
  assert.equal((await old.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(old.events.models.length, 0);
  const invalid = harness({ maxRevisions: -1 });
  await started(invalid);
  assert.equal((await invalid.step()).text, "UNPUBLISHED DRAFT");
  const headless = harness();
  await headless.fire("session.start", { isInteractive: false });
  await headless.prompt("request");
  assert.match((await headless.step()).text, /対話セッション/u);
  assert.equal(headless.events.models.length, 0);
});

test("truncated answers and stream failures show only that step's text", async () => {
  const h = harness();
  await started(h);
  assert.equal(
    (await h.step({ stopReason: "max_tokens" })).text,
    withNote(UNVERIFIED, "UNPUBLISHED DRAFT"),
  );
  assert.equal((await h.step({ fail: true, text: "PARTIAL" })).text, withNote(FAILED, "PARTIAL"));
  assert.equal((await h.step({ text: "NEXT" })).text, "NEXT");
  const empty = harness();
  await started(empty);
  assert.equal((await empty.step({ fail: true, text: "" })).text, NO_DRAFT);
});

test("session log works during review, shows findings without the draft and clears at session end", async () => {
  const h = harness();
  await started(h);
  assert.ok(h.events.commands.some((c) => c.name === "cgate" && c.immediate));
  const held = deferred();
  h.replies.push(() => held.promise);
  const running = h.step();
  await tick();
  const pending = (await h.fire("command.run", { command: "cgate", args: "log" })).text;
  assert.match(pending, /審査 #\d+: 開始/u);
  assert.doesNotMatch(pending, /UNPUBLISHED/u);
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "unknown" })).text,
    /使い方/u,
  );
  held.resolve({ isAnswered: true, text: verdict("REVISE", ["SECRET FINDING"]) });
  await running;
  await h.flushCorrections();
  await h.step();
  const log = (await h.fire("command.run", { command: "cerberus", args: " log " })).text;
  assert.match(log, /REVISE[\s\S]*PASS[\s\S]*検証済みの本文を公開/u);
  assert.match(log, /指摘と根拠:[\s\S]*SECRET FINDING/u);
  assert.doesNotMatch(log, /UNPUBLISHED/u);
  assert.match(log, /1970-01-01T00:00:00.000Z/u);
  await h.fire("session.end", {});
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "log" })).text,
    /ログはありません/u,
  );
});

test("cancellation while collecting conversation evidence does not start a reviewer", async () => {
  const h = harness();
  await started(h);
  const held = deferred();
  h.setMessages(() => held.promise);
  const running = h.step();
  await tick();
  await h.fire("command.run", { command: "cgate", args: "cancel" });
  held.resolve([]);
  assert.equal((await running).text, "");
  assert.equal(h.events.models.length, 0);
  assert.deepEqual(h.events.prompts, []);
});

test("a newer request or cancel invalidates a scheduled correction before dispatch", async () => {
  for (const cancel of [false, true]) {
    const h = harness();
    await started(h);
    h.replies.push(verdict("REVISE", ["SECRET FINDING"]));
    assert.equal((await h.step()).text, WAITING);
    if (cancel) await h.fire("command.run", { command: "cgate", args: "cancel" });
    else await h.prompt("new request");
    await h.flushCorrections();
    assert.deepEqual(h.events.prompts, []);
  }
});

test("reviewer model override and a shrinking total deadline are passed to the completion API", async () => {
  const h = harness({ reviewerModel: "haiku", reviewTimeoutSeconds: 10 });
  await started(h);
  h.replies.push(() => {
    h.advance(2000);
    return {
      isAnswered: true,
      text: JSON.stringify({ tool: "Read", input: { file_path: "fact.txt" } }),
    };
  }, verdict());
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
  assert.deepEqual(
    h.events.models.map((m) => m.request.model),
    ["haiku", "haiku"],
  );
  assert.deepEqual(
    h.events.models.map((m) => m.request.timeoutMs),
    [10000, 8000],
  );
});

test("built-in search tools stay available when omitted from the main tool list", async () => {
  const h = harness();
  await started(h);
  h.replies.push(
    JSON.stringify({ tool: "Glob", input: { pattern: "**/fact.txt" } }),
    JSON.stringify({ tool: "Grep", input: { pattern: "stable", path: "fact.txt" } }),
    verdict(),
  );
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
  assert.deepEqual(h.events.calls, ["Glob", "Grep"]);
  const names = JSON.parse(h.events.models[0].request.prompt).tools.map((tool) => tool.name);
  for (const name of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"])
    assert.ok(names.includes(name));
  assert.equal(h.events.statuses.at(-1), undefined);
  assert.ok(!h.events.statuses.includes(""));
});

let reloadSerial = 0;
async function reload(h, options = {}) {
  h.unload();
  const fresh = await import(`../plugins/cerberus-gate/hooks/register.ts?reload=${++reloadSerial}`);
  const next = harness(options, "2.1.310", h.host, fresh.register);
  await next.fire("session.start", { isInteractive: true });
  return next;
}

test("reload during work restores the request and reviews without a restart prompt", async () => {
  const h = harness();
  await started(h);
  await h.step({ tools: [{ name: "Read", input: { file_path: "fact.txt" } }] });
  const next = await reload(h);
  await next.flushCorrections();
  assert.equal(next.events.prompts.length, 0);
  assert.equal((await next.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(JSON.parse(next.events.models[0].request.prompt).request, "original request");
  assert.equal(next.host.states.get("recovery").pending, false);
});

test("reload during review restarts without restoring a private draft or accepting old controls", async () => {
  const h = harness();
  await started(h);
  const held = deferred();
  h.replies.push(() => held.promise);
  const running = h.step({ text: "PRIVATE OLD DRAFT" });
  await tick();
  const saved = h.host.states.get("recovery");
  assert.equal(saved.pending, true);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE OLD DRAFT/u);
  h.host.reviewers.push({
    id: "legacy-reviewer",
    type: "cerberus-gate:reviewer",
    spawnedBy: "cerberus-gate",
    status: "running",
  });
  const next = await reload(h);
  await next.flushCorrections();
  assert.deepEqual(next.events.calls, ["TaskStop"]);
  assert.equal(next.events.prompts.length, 1);
  assert.match(next.events.prompts[0].context.join(""), /original request/u);
  assert.ok(
    (
      await next.fire("prompt.submit", {
        origin: { kind: "plugin", name: "cerberus-gate" },
        text: `Cerberus Gate: 検証処理を継続します。 [${saved.epoch}-${saved.serial}]`,
      })
    ).drop,
  );
  assert.ok((await next.fire("tool.call", { agentId: "legacy-reviewer", tool: "Read" })).deny);
  held.resolve({ isAnswered: true, text: verdict() });
  assert.equal((await running).text, "");
  assert.equal((await next.step({ text: "FRESH DRAFT" })).text, "FRESH DRAFT");
  assert.equal(next.host.states.get("recovery").pending, false);
});

test("reload preserves correction counts across queued and accepted correction prompts", async () => {
  for (const accepted of [false, true]) {
    const h = harness({ maxRevisions: 2 });
    await started(h);
    h.replies.push(verdict("REVISE", ["PRIVATE FINDING"]));
    await h.step();
    if (accepted) await h.flushCorrections();
    const next = await reload(h);
    await next.flushCorrections();
    assert.equal(next.host.states.get("recovery").revisions, 1);
    assert.doesNotMatch(
      JSON.stringify(next.host.states.get("recovery")),
      /PRIVATE FINDING|UNPUBLISHED DRAFT/u,
    );
    next.replies.push(verdict("REVISE", ["still wrong"]));
    assert.equal((await next.step()).text, WAITING);
    await next.flushCorrections();
    next.replies.push(verdict("REVISE", ["still wrong"]));
    assert.equal((await next.step()).text, withNote(UNRESOLVED, "UNPUBLISHED DRAFT"));
    assert.equal(next.events.prompts.length, 2);
  }
});

test("published, unverified, cancelled, aborted and ended sessions do not auto-restart on reload", async () => {
  for (const event of ["publish", "unverified", "cancel", "turn.abort", "session.end"]) {
    const h = harness();
    await started(h);
    if (event === "unverified") h.replies.push("INVALID_REVIEW");
    await h.step();
    if (event === "cancel") await h.fire("command.run", { command: "cgate", args: "cancel" });
    else if (event !== "publish" && event !== "unverified") await h.fire(event, {});
    const next = await reload(h);
    await next.flushCorrections();
    assert.equal(next.events.prompts.length, 0, event);
    if (event === "session.end") assert.equal(next.host.states.get("recovery").prompt, "");
  }
});

test("new requests supersede a queued reload restart and failed restart delivery clears pending state", async () => {
  const h = harness();
  await started(h);
  h.replies.push(verdict("REVISE", ["finding"]));
  await h.step();
  const next = await reload(h);
  await next.prompt("new request");
  await next.flushCorrections();
  assert.equal(next.events.prompts.length, 0);
  assert.equal((await next.step({ text: "new answer" })).text, "new answer");
  assert.equal(JSON.parse(next.events.models[0].request.prompt).request, "new request");
  next.replies.push(verdict("REVISE", ["finding"]));
  await next.step();
  const again = await reload(next);
  again.failPrompt();
  await again.flushCorrections();
  assert.equal(again.host.states.get("recovery").pending, false);
  assert.match(
    (await again.fire("command.run", { command: "cgate", args: "log" })).text,
    /再開に失敗/u,
  );
});

test("reviewer model and effort inherit the answer step or use independent overrides", async () => {
  for (const [options, expectedModel, expectedEffort] of [
    [{}, "haiku", "high"],
    [{ reviewerModel: "sonnet" }, "sonnet", "high"],
    [{ reviewerEffort: "low" }, "haiku", "low"],
    [{ reviewerModel: "opus", reviewerEffort: "max" }, "opus", "max"],
  ]) {
    const h = harness(options);
    await h.prompt("request");
    await h.step({ effort: "high" });
    assert.equal(h.events.models[0].request.model, expectedModel);
    assert.equal(h.events.models[0].request.effort, expectedEffort);
  }
  assert.equal(readConfig({}).reviewerEffort, "inherit");
  for (const effort of ["inherit", "low", "medium", "high", "xhigh", "max"])
    assert.equal(readConfig({ reviewerEffort: effort }).reviewerEffort, effort);
  for (const effort of ["", "unknown", 10, false])
    assert.throws(() => readConfig({ reviewerEffort: effort }), /Invalid reviewerEffort/u);
  const h = harness();
  await h.prompt("request");
  await h.step();
  assert.equal(h.events.models[0].request.effort, undefined);
  await h.step({ effort: 10 });
  assert.equal(h.events.models[1].request.effort, undefined);
});

test("model picker saves model then effort and preserves both across repeated selections", async () => {
  const h = harness({ reviewerModel: "custom-model", reviewerEffort: "low" });
  await h.fire("command.run", { command: "cgate", args: "model" });
  assert.equal(h.events.pane.id, "reviewer-model");
  const picker = await h.fire("ui.render", {
    component: "Pane",
    requestId: "reviewer-model",
    surface: "terminal",
  });
  assert.equal(picker.value, "custom-model");
  assert.deepEqual(
    picker.options.map((o) => o.value),
    ["inherit", "haiku", "sonnet", "opus", "fable", "custom-model"],
  );
  assert.equal(h.events.setting, undefined);
  await picker.onSelect("fable");
  assert.deepEqual(h.events.setting, { key: "cerberus-gate.reviewerModel", value: "fable" });
  assert.equal(h.events.closed, true);
  assert.equal(h.events.pane.id, "reviewer-effort");
  const effort = await h.fire("ui.render", {
    component: "Pane",
    requestId: "reviewer-effort",
    surface: "terminal",
  });
  assert.equal(effort.value, "low");
  assert.deepEqual(
    effort.options.map((o) => o.value),
    ["inherit", "low", "medium", "high", "xhigh", "max"],
  );
  await effort.onSelect("high");
  assert.deepEqual(h.events.setting, { key: "cerberus-gate.reviewerEffort", value: "high" });
  await h.prompt("request");
  await h.step();
  assert.equal(h.events.models[0].request.model, "fable");
  assert.equal(h.events.models[0].request.effort, "high");
  await picker.onSelect("sonnet");
  await h.step();
  assert.equal(h.events.models[1].request.model, "sonnet");
  assert.equal(h.events.models[1].request.effort, "high");
  await effort.onSelect("inherit");
  await h.step({ effort: "medium" });
  assert.equal(h.events.models[2].request.model, "sonnet");
  assert.equal(h.events.models[2].request.effort, "medium");
});

test("a denied or failed model save preserves the previous reviewer model", async () => {
  for (const fails of [false, true]) {
    const h = harness();
    h.engine.config.set = async () => {
      if (fails) throw new Error("save failed");
      return { deny: "locked" };
    };
    const picker = await h.fire("ui.render", {
      component: "Pane",
      requestId: "reviewer-model",
      surface: "terminal",
    });
    await picker.onSelect("opus");
    assert.equal(h.events.closed, undefined);
    await h.prompt("request");
    await h.step();
    assert.equal(h.events.models[0].request.model, "haiku");
  }
});

test("a denied or failed effort save preserves the saved model and previous effort", async () => {
  for (const fails of [false, true]) {
    const h = harness({ reviewerEffort: "low" });
    const model = await h.fire("ui.render", {
      component: "Pane",
      requestId: "reviewer-model",
      surface: "terminal",
    });
    await model.onSelect("sonnet");
    h.events.closed = undefined;
    h.engine.config.set = async () => {
      if (fails) throw new Error("save failed");
      return { deny: "locked" };
    };
    const effort = await h.fire("ui.render", {
      component: "Pane",
      requestId: "reviewer-effort",
      surface: "terminal",
    });
    await effort.onSelect("high");
    assert.equal(h.events.closed, undefined);
    await h.prompt("request");
    await h.step();
    assert.equal(h.events.models[0].request.model, "sonnet");
    assert.equal(h.events.models[0].request.effort, "low");
  }
});

test("temporary settings notifications leave a pending review status intact", async () => {
  const h = harness();
  await h.prompt("request");
  const pending = deferred();
  h.replies.push(() => pending.promise);
  const step = h.step();
  while (!h.events.models.length) await new Promise((r) => setImmediate(r));
  const picker = await h.fire("ui.render", {
    component: "Pane",
    requestId: "reviewer-model",
    surface: "terminal",
  });
  await picker.onSelect("sonnet");
  assert.equal(h.events.statuses.at(-1), WAITING);
  assert.match(h.events.toasts.at(-1).text, /sonnet/);
  assert.equal(h.events.toasts.at(-1).options.timeoutMs, 3000);
  h.engine.config.set = async () => ({ deny: "locked" });
  await picker.onSelect("opus");
  assert.equal(h.events.statuses.at(-1), WAITING);
  assert.match(h.events.toasts.at(-1).text, /保存できませんでした/);
  assert.equal(h.events.toasts.at(-1).options.timeoutMs, 3000);
  pending.resolve({ isAnswered: true, text: verdict() });
  await step;
  assert.equal(h.events.statuses.at(-1), undefined);
});

async function chooseEnabled(h, argument, scope) {
  await h.fire("command.run", { command: "cgate", args: argument });
  const picker = await h.fire("ui.render", {
    component: "Pane",
    requestId: "enabled-scope",
    surface: "terminal",
  });
  await picker.onSelect(scope);
  return { text: h.events.toasts.at(-1).text };
}

test("enabled commands persist defaults and session overrides take precedence", async () => {
  const h = harness();
  await h.prompt("request");
  const command = (args) => h.fire("command.run", { command: "cgate", args });
  assert.match((await chooseEnabled(h, "off", "saved")).text, /off \(saved\)/u);
  assert.deepEqual(h.events.setting, { key: "cerberus-gate.enabled", value: false });
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(h.events.models.length, 0);
  assert.match((await chooseEnabled(h, "on", "session")).text, /on \(session\)/u);
  await h.step();
  assert.equal(h.events.models.length, 1);
  assert.match((await command("reset")).text, /off \(saved\)/u);
  assert.match((await chooseEnabled(h, "on", "saved")).text, /on \(saved\)/u);
  assert.match((await chooseEnabled(h, "off", "session")).text, /off \(session\)/u);
  await h.fire("session.end", {});
  assert.match((await command("")).text, /on \(saved\)/u);
});

test("session override survives reload without changing saved settings", async () => {
  const h = harness({ enabled: false });
  await chooseEnabled(h, "on", "session");
  assert.equal(h.events.setting, undefined);
  const reloaded = await reload(h, { enabled: false });
  assert.match(
    (await reloaded.fire("command.run", { command: "cgate", args: "" })).text,
    /on \(session\)/u,
  );
});

test("failed persistence preserves current enabled state and override", async () => {
  for (const result of [{ deny: "policy" }, { value: "false" }, new Error("failed")]) {
    const h = harness();
    await chooseEnabled(h, "off", "session");
    h.engine.config.set = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    assert.match((await chooseEnabled(h, "on", "saved")).text, /保存できません/u);
    assert.match(
      (await h.fire("command.run", { command: "cgate", args: "" })).text,
      /off \(session\)/u,
    );
  }
});

test("disabling during review cancels the held answer and stale verdict", async () => {
  const h = harness();
  await h.prompt("request");
  const held = deferred();
  h.replies.push(() => held.promise);
  const running = h.step();
  await tick();
  assert.match((await chooseEnabled(h, "off", "session")).text, /取り消しました/u);
  held.resolve({ isAnswered: true, text: verdict("REVISE", ["private finding"]) });
  assert.equal((await running).text, "");
  await h.flushCorrections();
  assert.equal(h.events.prompts.length, 0);
});

test("enabled configuration accepts only booleans", () => {
  assert.equal(readConfig({}).enabled, true);
  assert.equal(readConfig({ enabled: false }).enabled, false);
  assert.throws(() => readConfig({ enabled: "off" }), /Invalid enabled/u);
});

test("on and off only open the scope picker and removed flags do not change state", async () => {
  const h = harness();
  await h.fire("command.run", { command: "cgate", args: "off" });
  assert.equal(h.events.setting, undefined);
  assert.equal(h.events.pane.id, "enabled-scope");
  const picker = await h.fire("ui.render", {
    component: "Pane",
    requestId: "enabled-scope",
    surface: "terminal",
  });
  assert.deepEqual(
    picker.options.map((o) => o.value),
    ["session", "saved"],
  );
  assert.match((await h.fire("command.run", { command: "cgate", args: "" })).text, /on \(saved\)/u);
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "off --session" })).text,
    /使い方/u,
  );
  assert.equal(h.events.setting, undefined);
});
