import { asFixture } from "./fixture.ts";
import type { CerberusRecovery } from "../../plugins/cerberus-gate/types/index.d.ts";
import { register } from "../../plugins/cerberus-gate/hooks/register.ts";
import type { On, PluginOptions } from "claude-code";
interface ModelRequest {
  timeoutMs?: number;
  prompt: string;
  system: string;
  model: string;
  effort?: string | number;
}
interface ModelOptions {
  signal: AbortSignal;
}
type Reply = string | ((request: ModelRequest, options: ModelOptions) => unknown);
interface Result {
  text: string;
  context: string[];
  result?: string;
  drop?: boolean;
  decision: string;
  deny?: string;
  value: string;
  options: { value: string }[];
  onSelect: (value: string) => Promise<void>;
}
type Event = Record<string, unknown>;
type Handler = (engine: unknown, event: Event, next: unknown) => unknown;
interface Entry {
  matcher: Record<string, unknown>;
  handler: Handler;
  failure?: Handler;
}
interface Timer {
  ms: number;
  fn: () => unknown;
  cancelled: boolean;
  cancel(): void;
}
interface DebugRecord {
  event: string;
  sequence: number;
  data: {
    operationId: string;
    reason: string;
    request: ModelRequest;
    response: { text: string };
    error: { cause: string };
  };
}
interface Captured {
  prompts: Result[];
  statuses: (string | undefined)[];
  toasts: { text: string; options: { timeoutMs?: number } }[];
  calls: string[];
  models: { request: ModelRequest; options: ModelOptions }[];
  timers: Timer[];
  commands: { name: string; immediate: boolean }[];
  inputs: Event[];
  debug: DebugRecord[];
  pane?: { id: string };
  closed?: boolean;
  released?: boolean;
  materialRequests: unknown[];
  setting?: { key: string; value: unknown };
}
interface Host {
  states: Map<string, CerberusRecovery | null>;
  reviewers: { id: string; type: string; spawnedBy: string; status: string }[];
}
interface ProcessResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
interface StepOptions {
  agentId?: string;
  text?: string;
  tools?: { name: string; input: object }[];
  stopReason?: string;
  fail?: boolean;
  model?: string;
  effort?: string | number;
}
interface Chunk {
  kind: string;
  text?: string;
  index?: number;
  id?: string;
  name?: string;
  stopReason?: string;
  usage?: null;
}
interface StepResult {
  turnId: string;
  answer: string;
  toolUses: { name: string; input: object }[];
  stopReason: string;
  usage: null;
}
type StepStream = AsyncGenerator<Chunk, StepResult>;
export const verdict = (decision = "PASS", findings: string[] = []) =>
  JSON.stringify({ decision, findings });
export const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export function harness(
  options: Record<string, unknown> = {},
  version = "2.1.310",
  host: Host = { states: new Map(), reviewers: [] },
  registerHook = register,
) {
  const handlers = new Map<string, Entry[]>();
  const events: Captured = {
    prompts: [],
    statuses: [],
    toasts: [],
    calls: [],
    models: [],
    timers: [],
    commands: [],
    inputs: [],
    debug: [],
    materialRequests: [],
  };
  const replies: Reply[] = [];
  let draft = "UNPUBLISHED DRAFT";
  let time = 0;
  const controller = new AbortController();
  let callResult: unknown = {
    result: "read result",
    text: "fact.txt:1 stable",
    isReadOnly: true,
  };
  let promptFailure = false;
  let permission = "allow";
  let readOnly = true;
  let prepareMaterial: () => Promise<unknown> = async () => ({});
  const matches = (m: Record<string, unknown>, e: Event) =>
    Object.entries(m).every(([k, v]) =>
      v instanceof RegExp ? typeof e[k] === "string" && v.test(e[k]) : v === e[k],
    );
  registerHook(
    asFixture<On>((name: string, ...args: [Handler] | [Record<string, unknown>, Handler]) => {
      const [matcher, handler] = args.length === 1 ? [{}, args[0]] : args;
      const entry: Entry = { matcher, handler };
      handlers.set(name, [...(handlers.get(name) ?? []), entry]);
      return {
        catch(fn: Handler) {
          entry.failure = fn;
        },
      };
    }),
    asFixture<PluginOptions>(options),
  );
  const engine = {
    plugin: { root: "/plugin" },
    process: {
      run: async (
        argv: string[],
        processOptions: { stdin: string; timeoutMs: number },
      ): Promise<ProcessResult> => {
        if (argv[1]!.endsWith("/debug-log.mts")) {
          const input = JSON.parse(processOptions.stdin);
          events.debug.push(...(input.records ?? []));
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              directory: "/debug/session",
              events: "/debug/session/events.jsonl",
              index: "/debug/session/index.jsonl",
            }),
          };
        }
        if (argv[2] === "release") {
          events.released = true;
          return { exitCode: 0 };
        }
        events.materialRequests.push(JSON.parse(processOptions.stdin).request);
        await prepareMaterial();
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            directory: "/private/review",
            users: "/private/review/users.txt",
            history: "/private/review/history.txt",
            source: "/private/review/source.jsonl",
          }),
        };
      },
    },
    ui: {
      toast(text: string, toastOptions: { timeoutMs?: number }) {
        events.toasts.push({ text, options: toastOptions });
      },
      status(value: string | undefined) {
        events.statuses.push(value);
      },
      open: async (pane: { id: string }) => {
        events.pane = pane;
        return { isPlaced: true };
      },
      close: async () => {
        events.closed = true;
      },
      resolve: () => ({ Select: (props: unknown) => props, Text: (props: unknown) => props }),
    },
    config: {
      set: async (setting: {
        key: string;
        value: unknown;
      }): Promise<{ value: unknown } | { deny: string }> => {
        events.setting = setting;
        return { value: setting.value };
      },
    },
    state: {
      get: async (ref: { key: string }) => ({ value: structuredClone(host.states.get(ref.key)) }),
      set: async (ref: { key: string }, value: CerberusRecovery | null) => {
        host.states.set(ref.key, structuredClone(value));
        return { isSet: true, version: 1 };
      },
    },
    turn: { abort: async () => fire("turn.abort", {}) },
    command: {
      register: async (spec: { name: string; immediate: boolean }) => {
        events.commands.push(spec);
        return {};
      },
    },
    session: {
      id: async () => "session",
      cwd: async () => "/project",
      version: async () => ({ version, base: version }),
    },
    model: {
      complete: async (request: ModelRequest, callOptions: ModelOptions) => {
        events.models.push({ request, options: callOptions });
        const reply = replies.length ? replies.shift() : verdict();
        if (typeof reply === "function") return reply(request, callOptions);
        return { isAnswered: true, text: reply, usage: {} };
      },
    },
    tool: {
      list: async () =>
        ["Read", "Write", "Bash", "mcp__notes__search", "mcp__notes__write"].map((name) => ({
          name,
          description: name,
          mcp: name.startsWith("mcp__"),
        })),
      call: async (e: Event) => fire("tool.call", e, "cerberus-gate"),
    },
    agent: { list: async () => host.reviewers },
    prompt: {
      submit: async (e: Event) => {
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
      after: (ms: number, fn: () => unknown) => {
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
  const core = async (name: string, e: Event, origin: string): Promise<unknown> => {
    if (name === "prompt.submit") return { text: e.text, context: e.context };
    if (name === "tool.check") return { decision: permission };
    if (name === "tool.call") {
      const check = await fire(
        "tool.check",
        { tool: e.tool, input: e, ...(readOnly ? { isReadOnly: true } : {}) },
        origin,
      );
      if (check.decision !== "allow") return { deny: check.decision };
      events.calls.push(String(e.tool));
      events.inputs.push(e);
      return typeof callResult === "function" ? callResult(e) : callResult;
    }
    return {};
  };
  async function fire(name: string, e: Event, origin = "engine"): Promise<Result> {
    const chain = (handlers.get(name) ?? []).filter((h) => matches(h.matcher, e));
    const invoke = async (i: number): Promise<unknown> => {
      const entry = chain[i];
      if (!entry) return core(name, e, origin);
      const next = (arg: Event) => {
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
    return asFixture<Result>(await invoke(0));
  }
  async function step({
    agentId,
    text = draft,
    tools = [],
    stopReason = "end_turn",
    fail = false,
    model = "haiku",
    effort,
  }: StepOptions = {}) {
    const e = {
      turnId: "t",
      index: 0,
      model,
      effort,
      messageCount: 1,
      ...(agentId ? { agentId } : {}),
    };
    const chain = (handlers.get("turn.step") ?? []).filter((h) => matches(h.matcher, e));
    const invoke = (i: number): StepStream => {
      const entry = chain[i];
      if (!entry)
        return (async function* (): StepStream {
          yield { kind: "text", index: 0, text };
          if (fail) throw new Error("stream failure");
          for (const t of tools) yield { kind: "tool", index: 1, id: "tool-1", name: t.name };
          yield { kind: "stop", stopReason, usage: null };
          return { ...e, answer: text, toolUses: tools, stopReason, usage: null };
        })();
      const next = () => {
        const iterator = invoke(i + 1);
        let finish!: (value: StepResult) => void;
        const result = new Promise<StepResult>((resolve) => {
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
      return (async function* (): StepStream {
        try {
          return yield* asFixture<StepStream>(entry.handler(engine, e, next));
        } catch (error) {
          if (entry.failure) return yield* asFixture<StepStream>(entry.failure(engine, e, next));
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
    prompt: (text: string) =>
      fire("prompt.submit", { text, origin: { kind: "composer" }, wait: false }),
    setDraft: (text: string) => {
      draft = text;
    },
    setCall: (value: unknown) => {
      callResult = value;
    },
    setPermission: (value: string) => {
      permission = value;
    },
    setReadOnly: (value: boolean) => {
      readOnly = value;
    },
    setPreparation: (read: () => Promise<unknown>) => {
      prepareMaterial = read;
    },
    failPrompt: () => {
      promptFailure = true;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}
export const started = async (h: ReturnType<typeof harness>) => {
  await h.fire("session.start", { isInteractive: true });
  await h.prompt("original request");
};
export const tick = () => new Promise((resolve) => setImmediate(resolve));
