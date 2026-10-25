import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../plugins/cerberus-gate/hooks/register.ts";
import { WAITING, UNVERIFIED } from "../plugins/cerberus-gate/hooks/policy.ts";

function harness(options = {}) {
  const handlers = new Map();
  const events = { prompts: [], calls: [], inputs: [], agents: [], timers: [] };
  let counter = 0;
  let draft = "UNPUBLISHED DRAFT";
  const matches = (m, e) =>
    Object.entries(m).every(([k, v]) =>
      v instanceof RegExp ? typeof e[k] === "string" && v.test(e[k]) : v === e[k],
    );
  register((name, ...args) => {
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
    ui: { status() {} },
    command: { register: async () => ({}) },
    session: {
      version: async () => ({ version: "2.1.310", base: "2.1.310" }),
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
      list: async () => [],
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
    if (name === "agent.spawn") return { model: "haiku", agentId: `review-${++counter}` };
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
  } = {}) {
    const e = {
      turnId: "t",
      index: 0,
      model: "haiku",
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
    const agentId = `review-${counter}`;
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
  assert.deepEqual(h.events.agents[0].tools, ["Read"]);
  assert.equal(
    (await h.fire("tool.call", { agentId: "review-1", tool: "Write" })).deny.includes("read-only"),
    true,
  );
  assert.deepEqual(h.events.calls, []);
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

test("timeout, revision cap and malformed verdict all withhold the draft", async () => {
  const timeout = harness();
  await timeout.prompt("request");
  await timeout.step();
  await timeout.events.timers[0].fn();
  assert.equal((await timeout.step()).text, UNVERIFIED);
  const cap = harness({ maxRevisions: 0 });
  await cap.prompt("request");
  await cap.step();
  await cap.finish("REVISE", ["error"]);
  assert.equal((await cap.step()).text, UNVERIFIED);
  const bad = harness();
  await bad.prompt("request");
  await bad.step();
  await bad.step({ agentId: "review-1", text: "PASS" });
  await bad.fire("turn.complete", { agentId: "review-1", reason: "answer" });
  assert.equal((await bad.step()).text, UNVERIFIED);
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

test("tool steps proceed; stream failures never replay the buffered draft", async () => {
  const h = harness();
  await h.prompt("request");
  const tools = await h.step({ tools: [{ name: "Read", input: { file_path: "fact.txt" } }] });
  assert.ok(tools.chunks.some((c) => c.kind === "tool"));
  assert.equal(h.events.agents.length, 0);
  assert.equal((await h.step({ fail: true })).text, UNVERIFIED);
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
