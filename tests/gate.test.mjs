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

function harness(
  options = {},
  version = "2.1.310",
  host = { states: new Map(), reviewers: [], counter: 0 },
  registerHook = register,
) {
  const handlers = new Map();
  const events = {
    prompts: [],
    calls: [],
    inputs: [],
    agents: [],
    timers: [],
    commands: [],
    spawns: [],
  };

  let draft = "UNPUBLISHED DRAFT";
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
      status() {},
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
    command: {
      register: async (spec) => {
        events.commands.push(spec);
        return {};
      },
    },
    session: {
      version: async () => ({ version, base: version }),
      messages: async () => [{ role: "user", content: "original request" }],
    },
    tool: {
      list: async () => [
        { name: "Read" },
        { name: "Write" },
        { name: "Bash" },
        { name: "mcp__notes__search" },
      ],
      call: async (e) => fire("tool.call", e),
    },
    agent: {
      list: async () => host.reviewers,
      register: async (e) => {
        events.agents.push(e);
      },
      spawn: async (e) => fire("agent.spawn", e),
    },
    prompt: {
      submit: async (e) => {
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
      now: async () => 0,
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
  const core = async (name, e) => {
    if (name === "agent.spawn") {
      events.spawns.push(e);
      const agentId = `review-${++host.counter}`;
      host.reviewers.push({
        id: agentId,
        type: "cerberus-gate:reviewer",
        spawnedBy: "cerberus-gate",
        status: "running",
      });
      return { model: "haiku", agentId };
    }
    if (name === "prompt.submit") return { text: e.text, context: e.context };
    if (name === "turn.complete") return { text: e.answer };
    if (name === "tool.check") return { decision: "allow" };
    if (name === "tool.call") {
      events.calls.push(e.tool);
      events.inputs.push(e);
      return { result: "read result" };
    }
    return {};
  };
  const signal = new AbortController().signal;
  async function fire(name, e) {
    const chain = (handlers.get(name) ?? []).filter((h) => matches(h.matcher, e));
    const invoke = async (index) => {
      const entry = chain[index];
      if (!entry) return core(name, e);
      const next = (arg) => {
        e = arg;
        return invoke(index + 1);
      };
      Object.assign(next, { signal, origin: { plugin: "cerberus-gate" } });
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
    const invoke = (index) => {
      const entry = chain[index];
      if (!entry)
        return (async function* () {
          yield { kind: "text", index: 0, text };
          if (fail) throw new Error("stream failure");
          for (const t of tools) yield { kind: "tool", index: 1, id: "tool-1", name: t.name };
          yield { kind: "stop", stopReason, usage: null };
          return { ...e, answer: text, toolUses: tools, stopReason, usage: null };
        })();
      const next = () => {
        const iterator = invoke(index + 1);
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
      Object.assign(next, { signal, origin: { plugin: "cerberus-gate" } });
      return (async function* () {
        try {
          return yield* entry.handler(engine, e, next);
        } catch (error) {
          if (entry.failure) return yield* entry.failure(engine, e, next);
          throw error;
        }
      })();
    };
    const chunks = [];
    const stream = invoke(0);
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
  const prompt = (text) =>
    fire("prompt.submit", { text, origin: { kind: "composer" }, wait: false });
  const finish = async (decision = "PASS", findings = []) => {
    const agentId = `review-${host.counter}`;
    await step({ agentId, text: JSON.stringify({ decision, findings }) });
    await fire("turn.complete", {
      agentId,
      turnId: "review-turn",
      answer: "private verdict",
      reason: "answer",
      isAborted: false,
      durationMs: 1,
    });
  };
  return {
    events,
    host,
    engine,
    step,
    fire,
    prompt,
    finish,
    setDraft: (t) => {
      draft = t;
    },
  };
}

test("draft is withheld; read-only reviewer approves the exact stored text once", async () => {
  const h = harness();
  await h.prompt("original request");
  assert.equal((await h.step()).text, WAITING);
  assert.deepEqual(h.events.agents[0].tools, ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
  for (const tool of ["Grep", "Glob"]) {
    assert.equal((await h.fire("tool.check", { agentId: "review-1", tool })).decision, "allow");
    assert.equal((await h.fire("tool.call", { agentId: "review-1", tool })).result, "read result");
  }
  assert.equal(
    (await h.fire("tool.call", { agentId: "review-1", tool: "Write" })).deny.includes("read-only"),
    true,
  );
  assert.deepEqual(h.events.calls, ["Grep", "Glob"]);
  const review = await h.step({ agentId: "review-1", text: '{"decision":"PASS","findings":[]}' });
  assert.ok(!review.text.includes("PASS"));
  await h.fire("turn.complete", { agentId: "review-1", reason: "answer", answer: "hidden" });
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(h.events.prompts.length, 1);
});

test("corrections are hidden context to main; revised answer is reviewed again", async () => {
  const h = harness();
  await h.prompt("fix the task");
  await h.step();
  await h.finish("REVISE", ["fact.txt:1 contradicts the draft"]);
  const sent = h.events.prompts[0];
  assert.ok(!sent.text.includes("UNPUBLISHED"));
  assert.ok(sent.context.join("").includes("fact.txt:1"));
  h.setDraft("CORRECTED");
  assert.equal((await h.step()).text, WAITING);
  await h.finish();
  assert.equal((await h.step()).text, "CORRECTED");
});

test("MCP requires an exact allow-list and a read-only call without overriding permissions", async () => {
  const h = harness({ readOnlyMcpTools: "mcp__notes__search" });
  await h.prompt("request");
  await h.step();
  assert.equal(
    (await h.fire("tool.check", { agentId: "review-1", tool: "mcp__notes__search" })).decision,
    "deny",
  );
  assert.equal(
    (
      await h.fire("tool.check", {
        agentId: "review-1",
        tool: "mcp__notes__search",
        isReadOnly: true,
      })
    ).decision,
    "allow",
  );
  assert.equal(
    (await h.fire("tool.call", { agentId: "review-1", tool: "Bash" })).deny.includes("read-only"),
    true,
  );
  assert.equal((await h.fire("tool.call", { tool: "Write" })).result, "read result");
});

test("timeout, revision cap and malformed verdict show the draft with a note", async () => {
  const timeout = harness();
  await timeout.prompt("request");
  await timeout.step();
  await timeout.events.timers[0].fn();
  assert.equal((await timeout.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  const cap = harness({ maxRevisions: 0 });
  await cap.prompt("request");
  await cap.step();
  await cap.finish("REVISE", ["SECRET FINDING"]);
  const capped = (await cap.step()).text;
  assert.equal(capped, withNote(UNRESOLVED, "UNPUBLISHED DRAFT"));
  assert.doesNotMatch(capped, /SECRET FINDING/u);
  const bad = harness();
  await bad.prompt("request");
  await bad.step();
  await bad.step({ agentId: "review-1", text: "PASS" });
  await bad.fire("turn.complete", { agentId: "review-1", reason: "answer" });
  assert.equal((await bad.step()).text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
});

test("truncated answers and unsupported versions are shown without review", async () => {
  const truncated = harness();
  await truncated.prompt("request");
  const cut = await truncated.step({ stopReason: "max_tokens" });
  assert.equal(cut.text, withNote(UNVERIFIED, "UNPUBLISHED DRAFT"));
  assert.equal(truncated.events.agents.length, 0);
  const old = harness({}, "2.1.300");
  await old.fire("session.start", { isInteractive: true });
  await old.prompt("request");
  assert.equal((await old.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(old.events.agents.length, 0);
});

test("new prompt and abort prevent stale review publication; unrelated subagents are unchanged", async () => {
  const h = harness();
  await h.prompt("old");
  await h.step();
  await h.prompt("new");
  await h.finish();
  assert.equal(h.events.prompts.length, 0);
  assert.equal((await h.step({ agentId: "other", text: "other response" })).text, "other response");
  await h.step();
  await h.fire("turn.abort", {});
  await h.finish();
  assert.equal(h.events.prompts.length, 0);
});

test("tool steps proceed; stream failures show only the failed step's text", async () => {
  const h = harness();
  await h.prompt("request");
  const tools = await h.step({ tools: [{ name: "Read", input: { file_path: "fact.txt" } }] });
  assert.ok(tools.chunks.some((c) => c.kind === "tool"));
  assert.equal(h.events.agents.length, 0);
  assert.equal((await h.step({ fail: true, text: "PARTIAL" })).text, withNote(FAILED, "PARTIAL"));
  assert.equal((await h.step({ text: "NEXT" })).text, "NEXT");
  const empty = harness();
  await empty.prompt("request");
  assert.equal((await empty.step({ fail: true, text: "" })).text, NO_DRAFT);
});

test("internal handback never delivers raw findings or wakes main as a peer", async () => {
  const h = harness();
  await h.prompt("request");
  await h.step();
  await h.fire("tool.call", {
    tool: "SubagentHandback",
    agentId: "review-1",
    message: '{"decision":"PASS","findings":[]}',
  });
  const message = h.events.inputs.at(-1).message;
  assert.ok(!message.includes("PASS"));
  assert.equal(
    (
      await h.fire("prompt.submit", { text: message, origin: { kind: "peer" }, wait: false })
    ).drop.includes("処理済み"),
    true,
  );
  await h.fire("turn.complete", { agentId: "review-1", reason: "answer" });
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
});

test("headless mode fails closed without generating an unreviewed answer", async () => {
  const h = harness();
  await h.fire("session.start", { isInteractive: false });
  await h.prompt("request");
  assert.ok((await h.step()).text.includes("対話セッション"));
  assert.equal(h.events.agents.length, 0);
});

test("cgate is registered for immediate use and log does not disturb a pending review", async () => {
  const h = harness();
  await h.fire("session.start", { isInteractive: true });
  assert.ok(h.events.commands.some((c) => c.name === "cgate" && c.immediate));
  await h.prompt("SECRET REQUEST");
  await h.step();
  const before = await h.fire("command.run", { command: "cgate", args: "log" });
  assert.match(before.text, /審査 #\d+: 開始/u);
  assert.match(before.text, /1970-01-01T00:00:00.000Z/u);
  assert.doesNotMatch(before.text, /SECRET REQUEST|UNPUBLISHED DRAFT/u);
  assert.equal(h.events.prompts.length, 0);
  await h.finish();
  assert.equal((await h.step()).text, "UNPUBLISHED DRAFT");
  const after = await h.fire("command.run", { command: "cgate", args: " log " });
  assert.match(after.text, /PASS[\s\S]*検証済みの本文を公開/u);
  assert.equal(after.context, undefined);
});

test("session logs survive requests and cancellation, hide findings, and clear at session end", async () => {
  const h = harness();
  await h.prompt("first");
  await h.step();
  await h.finish("REVISE", ["SECRET FINDING"]);
  await h.step();
  await h.fire("command.run", { command: "cgate", args: "cancel" });
  const cancelled = await h.fire("command.run", { command: "cgate", args: "log" });
  assert.match(cancelled.text, /REVISE[\s\S]*修正を依頼[\s\S]*取り消しました/u);
  assert.doesNotMatch(cancelled.text, /SECRET FINDING|UNPUBLISHED DRAFT/u);
  await h.prompt("second");
  await h.step();
  await h.finish();
  await h.step();
  const text = (await h.fire("command.run", { command: "cgate", args: "log" })).text;
  assert.match(text, /REVISE[\s\S]*PASS/u);
  await h.fire("session.end", { reason: "clear" });
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "log" })).text,
    /ログはありません/u,
  );
});

test("cgate reports timeout and errors; unknown arguments are harmless and cerberus stays available", async () => {
  const h = harness();
  await h.prompt("request");
  await h.step();
  const invalid = await h.fire("command.run", { command: "cgate", args: "unknown" });
  assert.match(invalid.text, /使い方/u);
  await h.events.timers[0].fn();
  await h.step();
  const text = (await h.fire("command.run", { command: "cgate", args: "log" })).text;
  assert.match(text, /タイムアウト[\s\S]*UNVERIFIED[\s\S]*注記付きで表示/u);
  await h.prompt("next");
  await h.step({ fail: true });
  assert.match(
    (await h.fire("command.run", { command: "cgate", args: "log" })).text,
    /エラーが発生/u,
  );
  assert.match(
    (await h.fire("command.run", { command: "cerberus", args: "cancel" })).text,
    /cancelled/u,
  );
});

let reloadSerial = 0;
async function reload(h) {
  const fresh = await import(`../plugins/cerberus-gate/hooks/register.ts?reload=${++reloadSerial}`);
  const next = harness({}, "2.1.310", h.host, fresh.register);
  await next.fire("session.start", { isInteractive: true });
  return next;
}

test("reload during work retains the request and reviews the next answer", async () => {
  const h = harness();
  await h.prompt("original request");
  await h.step({ tools: [{ name: "Read" }] });
  const next = await reload(h);
  assert.equal(next.events.prompts.length, 0);
  assert.equal((await next.step()).text, WAITING);
  assert.equal(JSON.parse(next.events.spawns[0].prompt).request, "original request");
  await next.finish();
  assert.equal((await next.step()).text, "UNPUBLISHED DRAFT");
  assert.equal(next.host.states.get("recovery").pending, false);
});

test("reload during review stops old reviewers and regenerates without restoring drafts", async () => {
  const h = harness();
  await h.prompt("original request");
  await h.step({ text: "PRIVATE OLD DRAFT" });
  const saved = h.host.states.get("recovery");
  const oldControl = `Cerberus Gate: 検証処理を継続します。 [${saved.epoch}-${saved.serial}]`;
  const next = await reload(h);
  assert.deepEqual(next.events.calls, ["TaskStop"]);
  assert.equal(next.events.prompts.length, 1);
  assert.match(next.events.prompts[0].context[0], /original request/u);
  assert.doesNotMatch(JSON.stringify(next.host.states.get("recovery")), /PRIVATE OLD DRAFT/u);
  assert.ok(
    (
      await next.fire("prompt.submit", {
        text: oldControl,
        origin: { kind: "plugin", name: "cerberus-gate" },
      })
    ).drop,
  );
  await next.fire("turn.complete", { agentId: "review-1", reason: "answer" });
  assert.equal(next.events.prompts.length, 1);
  assert.ok((await next.fire("tool.call", { agentId: "review-1", tool: "Read" })).deny);
  assert.equal((await next.step({ text: "FRESH DRAFT" })).text, WAITING);
  await next.finish();
  assert.equal((await next.step()).text, "FRESH DRAFT");
});

test("reload preserves correction limits and invalidates a queued publication", async () => {
  const h = harness({ maxRevisions: 2 });
  await h.prompt("request");
  await h.step();
  await h.finish("REVISE", ["private finding"]);
  const next = await reload(h);
  assert.equal(next.host.states.get("recovery").revisions, 1);
  assert.doesNotMatch(
    JSON.stringify(next.host.states.get("recovery")),
    /private finding|UNPUBLISHED DRAFT/u,
  );
  await next.step();
  await next.finish();
  // PASS has queued publication but no turn.step has delivered it yet.
  const again = await reload(next);
  assert.equal(again.events.prompts.length, 1);
  assert.equal((await again.step({ text: "REGENERATED" })).text, WAITING);
  await again.finish("REVISE", ["still wrong"]);
  await again.step({ text: "CORRECTED" });
  await again.finish("REVISE", ["still wrong"]);
  assert.match((await again.step()).text, /修正回数の上限/u);
});

test("cancel, interruption, and session end cannot restart an old review after reload", async () => {
  for (const event of ["cancel", "turn.abort", "session.end"]) {
    const h = harness();
    await h.prompt("request");
    await h.step();
    if (event === "cancel") await h.fire("command.run", { command: "cgate", args: "cancel" });
    else await h.fire(event, {});
    const next = await reload(h);
    assert.equal(next.events.prompts.length, 0);
    if (event === "session.end") assert.equal(next.host.states.get("recovery").prompt, "");
  }
});

test("a new user request supersedes a queued reload restart", async () => {
  const h = harness();
  await h.prompt("old request");
  await h.step();
  const next = await reload(h);
  await next.prompt("new request");
  await next.step({ text: "new answer" });
  assert.equal(JSON.parse(next.events.spawns[0].prompt).request, "new request");
  await next.finish();
  assert.equal((await next.step()).text, "new answer");
});

test("failed reload resumption is logged and does not leave a pending gate", async () => {
  const h = harness();
  await h.prompt("request");
  await h.step();
  const fresh = await import(`../plugins/cerberus-gate/hooks/register.ts?reload=${++reloadSerial}`);
  const next = harness({}, "2.1.310", h.host, fresh.register);
  next.engine.prompt.submit = async () => {
    throw new Error("unavailable");
  };
  await next.fire("session.start", { isInteractive: true });
  assert.equal(next.host.states.get("recovery").pending, false);
  assert.match(
    (await next.fire("command.run", { command: "cgate", args: "log" })).text,
    /再開に失敗/u,
  );
  await next.prompt("continue");
  assert.equal((await next.step()).text, WAITING);
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
    assert.equal(h.events.agents[0].model, expectedModel);
    assert.equal(h.events.agents[0].effort, expectedEffort);
  }
  assert.equal(readConfig({}).reviewerEffort, "inherit");
  for (const effort of ["inherit", "low", "medium", "high", "xhigh", "max"])
    assert.equal(readConfig({ reviewerEffort: effort }).reviewerEffort, effort);
  for (const effort of ["", "unknown", 10, false])
    assert.throws(() => readConfig({ reviewerEffort: effort }), /Invalid reviewerEffort/u);
  const h = harness();
  await h.prompt("request");
  await h.step();
  assert.equal(h.events.agents[0].effort, undefined);
});

test("model picker saves selection and applies it to the next review", async () => {
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
    ["inherit", "haiku", "sonnet", "opus", "custom-model"],
  );
  assert.equal(h.events.setting, undefined);
  await picker.onSelect("haiku");
  assert.deepEqual(h.events.setting, { key: "cerberus-gate.reviewerModel", value: "haiku" });
  assert.equal(h.events.closed, true);
  await h.prompt("request");
  await h.step();
  assert.equal(h.events.agents[0].model, "haiku");
  assert.equal(h.events.agents[0].effort, "low");
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
    assert.equal(h.events.agents[0].model, "haiku");
  }
});
