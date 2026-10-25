import {
  allowedTool,
  CONTROL,
  correction,
  MAX_DRAFT,
  parseVerdict,
  readConfig,
  REVIEWER,
  REVIEW_PROMPT,
  UNVERIFIED,
  WAITING,
} from "./policy.ts";
import { createState, current, disposition, reset } from "./state.ts";
import type { Candidate, Delivery } from "./state.ts";
import type { Config, Verdict } from "./policy.ts";
import type {
  EngineInterface,
  Hook,
  Register,
  Timer,
  TurnStepInput,
  TurnStepResult,
} from "claude-code";

const gate = createState();
let config: Config = readConfig({});
let configured = true;
let interactive = true;
let timer: Timer | undefined;
const controlText = (delivery: Delivery): string =>
  `${CONTROL} [${delivery.epoch}-${delivery.token}]`;
const resultOf = (e: TurnStepInput, answer: string): TurnStepResult => ({
  turnId: e.turnId,
  index: e.index,
  answer,
  toolUses: [],
  stopReason: "end_turn",
  usage: null,
});

// 審査結果や破棄原稿を通知経路から流さず、制御プロンプトの context にだけ渡す。
async function dispatch($: EngineInterface, candidate: Candidate, verdict: Verdict): Promise<void> {
  if (!current(gate, candidate)) return;
  timer?.cancel();
  timer = undefined;
  const mode = disposition(verdict, gate.revisions, config.maxRevisions);
  const delivery: Delivery = {
    token: candidate.token,
    epoch: candidate.epoch,
    mode,
    text: mode === "publish" ? candidate.text : UNVERIFIED,
  };
  if (mode === "revise") {
    gate.revisions++;
    delivery.context = correction(candidate.text, verdict.findings);
  }
  gate.active = undefined;
  gate.delivery = delivery;
  gate.phase = mode === "revise" ? "correction queued" : mode;
  const sent = await $.prompt.submit({ text: controlText(delivery) }).catch(() => undefined);
  if (sent === undefined || sent.drop !== undefined) {
    if (gate.epoch === delivery.epoch) {
      gate.delivery = undefined;
      gate.action = undefined;
      gate.blocked = true;
      gate.phase = "unverified";
    }
    $.ui.status(UNVERIFIED);
  }
}

async function startReview($: EngineInterface, e: TurnStepInput, text: string): Promise<void> {
  const messages = await $.session.messages({ as: "api" });
  const context = JSON.stringify(messages).slice(-80_000);
  const candidate: Candidate = {
    token: ++gate.serial,
    epoch: gate.epoch,
    text,
    context,
    rawReview: "",
  };
  gate.active = candidate;
  gate.phase = "reviewing";
  const available = await $.tool.list();
  const tools = available.map((t) => t.name).filter((t) => allowedTool(t, config));
  await $.agent.register({
    name: "reviewer",
    description: "Verify the unpublished final answer using read-only evidence.",
    prompt: REVIEW_PROMPT,
    tools,
    model: config.reviewerModel === "inherit" ? e.model : config.reviewerModel,
    maxTurns: 8,
    omitClaudeMd: true,
  });
  const spawned = await $.agent.spawn({
    subagentType: REVIEWER,
    description: "Cerberus: 回答の根拠を検証",
    prompt: JSON.stringify({ request: gate.prompt, conversation: context, unpublishedDraft: text }),
  });
  if (!current(gate, candidate)) return;
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    await dispatch($, candidate, { decision: "UNVERIFIED", findings: [] });
    return;
  }
  candidate.agentId = spawned.agentId;
  gate.reviewers.add(spawned.agentId);
  timer = $.clock.after(config.reviewTimeoutMs, async () => {
    if (!current(gate, candidate)) return;
    await dispatch($, candidate, { decision: "UNVERIFIED", findings: [] });
    await $.tool.call({ tool: "TaskStop", task_id: spawned.agentId }).catch(() => undefined);
  });
}

const onStep: Hook<"turn.step"> = async function* ($, e, next) {
  if (e.agentId !== undefined) return yield* next(e);
  const epoch = gate.epoch;
  const action = gate.action;
  if (action !== undefined && action.mode !== "revise") {
    gate.action = undefined;
    gate.phase = action.mode === "publish" ? "published" : "unverified";
    if (next.signal.aborted || action.epoch !== gate.epoch) return resultOf(e, "");
    $.ui.status("");
    yield { kind: "text", index: 0, text: action.text };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, action.text);
  }
  gate.action = undefined;
  if (!interactive) {
    const notice =
      "Cerberus Gate は対話セッションで利用してください。未検証の回答は生成・公開していません。";
    yield { kind: "text", index: 0, text: notice };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, notice);
  }
  if (!configured || gate.blocked || !gate.prompt) {
    yield { kind: "text", index: 0, text: UNVERIFIED };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, UNVERIFIED);
  }
  if (gate.active !== undefined || gate.delivery !== undefined) {
    yield { kind: "text", index: 0, text: WAITING };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, WAITING);
  }
  const stream = next(e);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size +=
      chunk.kind === "text" || chunk.kind === "thinking"
        ? chunk.text.length
        : chunk.kind === "input"
          ? chunk.json.length
          : 0;
    if (size > 1_000_000) throw new Error("Response buffer limit");
    chunks.push(chunk);
  }
  const response = await stream.result;
  if (next.signal.aborted || epoch !== gate.epoch) return resultOf(e, "");
  const hasTools = response.toolUses.length > 0 || chunks.some((c) => c.kind === "tool");
  if (hasTools) {
    yield* chunks;
    return response;
  }
  const text = chunks
    .filter((c) => c.kind === "text")
    .map((c) => c.text)
    .join("");
  if (!text.trim()) {
    yield* chunks;
    return response;
  }
  if (
    (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") ||
    text.length > MAX_DRAFT
  ) {
    yield { kind: "text", index: 0, text: UNVERIFIED };
    yield { kind: "stop", stopReason: "end_turn", usage: response.usage };
    return resultOf(e, UNVERIFIED);
  }
  $.ui.status(WAITING);
  await startReview($, e, text);
  if (next.signal.aborted) return resultOf(e, "");
  // 空本文はエンジンが再生成するため、下書きに代えて状況だけを返す。
  yield { kind: "text", index: 0, text: WAITING };
  yield { kind: "stop", stopReason: "end_turn", usage: response.usage };
  return { ...response, answer: WAITING };
};

// 異常終了時に元のストリームへフォールバックしない。
const stepFailure: Hook<"turn.step"> = async function* ($, e) {
  gate.blocked = true;
  gate.active = undefined;
  gate.delivery = undefined;
  gate.action = undefined;
  timer?.cancel();
  $.ui.status("");
  yield { kind: "text", index: 0, text: UNVERIFIED };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return resultOf(e, UNVERIFIED);
};

const onReviewerStep: Hook<"turn.step"> = async function* (_$, e, next) {
  if (e.agentId === undefined || !gate.reviewers.has(e.agentId)) return yield* next(e);
  const candidate = gate.active?.agentId === e.agentId ? gate.active : undefined;
  const stream = next(e);
  let text = "";
  for await (const chunk of stream) {
    if (chunk.kind === "text") {
      text += chunk.text;
      if (text.length > MAX_DRAFT) throw new Error("Review too long");
    } else if (chunk.kind !== "thinking") yield chunk;
  }
  const response = await stream.result;
  if (
    candidate !== undefined &&
    !candidate.rawReview &&
    response.toolUses.length === 0 &&
    (response.stopReason === "end_turn" || response.stopReason === "stop_sequence")
  )
    candidate.rawReview = text;
  if (text && response.toolUses.length === 0)
    yield { kind: "text", index: 0, text: "検証処理が完了しました。" };
  return { ...response, answer: "" };
};

const onComplete: Hook<"turn.complete"> = async ($, e, next) => {
  const result = await next(e);
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId)) {
    // 完了後のタスク通知と遅延したツール呼び出しも識別するため、ID を保持する。
    const candidate = gate.active;
    if (candidate?.agentId === e.agentId) {
      const verdict =
        e.reason === "answer"
          ? parseVerdict(candidate.rawReview)
          : { decision: "UNVERIFIED" as const, findings: [] };
      await dispatch($, candidate, verdict);
    }
    return result;
  }
  if (e.agentId === undefined && e.isAborted) {
    timer?.cancel();
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
  }
  return result;
};

const onPrompt: Hook<"prompt.submit"> = async (_$, e, next) => {
  if (e.origin.kind === "plugin" && e.origin.name === "cerberus-gate") {
    const delivery = gate.delivery;
    if (delivery === undefined || e.text !== controlText(delivery) || delivery.epoch !== gate.epoch)
      return { drop: "Cerberus: 古い検証処理を破棄しました。" };
    gate.action = delivery;
    gate.delivery = undefined;
    return next({
      ...e,
      context: [...(e.context ?? []), ...(delivery.context ? [delivery.context] : [])],
    });
  }
  // 自分の審査の通知だけを除外し、他のバックグラウンド処理には干渉しない。
  if (
    (e.origin.kind === "task-notification" ||
      e.origin.kind === "peer" ||
      e.origin.kind === "peer-send-message") &&
    [...gate.reviewers].some((id) => e.text.includes(id))
  )
    return { drop: "Cerberus: 検証結果を処理済みです。" };
  timer?.cancel();
  timer = undefined;
  reset(gate, e.text);
  return next(e);
};

const onTool: Hook<"tool.call"> = async (_$, e, next) => {
  if (e.agentId === undefined || !gate.reviewers.has(e.agentId)) return next(e);
  // エンジンの結果返却も非公開で受け取り、親へ届く通知には定型文だけを残す。
  if (e.tool === "SubagentHandback" && gate.active?.agentId === e.agentId) {
    if ("message" in e && typeof e.message === "string") gate.active.rawReview = e.message;
    return next({ ...e, message: `Cerberus Gate reviewer ${e.agentId}: completed.` });
  }
  if (gate.active?.agentId !== e.agentId || !allowedTool(e.tool, config))
    return { deny: "Cerberus reviewer: only approved read-only tools are permitted." };
  return next(e);
};
const onCheck: Hook<"tool.check"> = async (_$, e, next) => {
  if (e.agentId === undefined || !gate.reviewers.has(e.agentId)) return next(e);
  if (e.tool === "SubagentHandback" && gate.active?.agentId === e.agentId) return next(e);
  if (!allowedTool(e.tool, config) || (config.mcpTools.includes(e.tool) && e.isReadOnly !== true))
    return {
      decision: "deny",
      reason: "Cerberus: connector calls must be explicitly allowed and read-only.",
    };
  return next(e);
};

export const register: Register = (on, options) => {
  configured = true;
  try {
    config = readConfig(options);
  } catch {
    configured = false;
  }
  on("session.start", async ($, e, next) => {
    interactive = e.isInteractive;
    const version = await $.session.version();
    configured = configured && version.base === "2.1.310";
    // 再ロードで失った原稿を公開せず、残っている自分の審査だけを停止する。
    for (const agent of await $.agent.list()) {
      if (agent.type !== REVIEWER || agent.spawnedBy !== "cerberus-gate") continue;
      gate.reviewers.add(agent.id);
      if (agent.status === "running")
        await $.tool.call({ tool: "TaskStop", task_id: agent.id }).catch(() => undefined);
    }
    await $.command.register({ name: "cerberus", description: "回答検証の状態を表示" });
    return next(e);
  });
  on("command.run", { command: "cerberus" }, async ($, e) => {
    if (e.args.trim() === "cancel") {
      const id = gate.active?.agentId;
      timer?.cancel();
      reset(gate, gate.prompt);
      gate.phase = "cancelled";
      if (id !== undefined)
        await $.tool.call({ tool: "TaskStop", task_id: id }).catch(() => undefined);
    }
    return { text: `Cerberus Gate: ${gate.phase}; corrections=${gate.revisions}` };
  });
  on("agent.offer", { agent: "cerberus-gate:reviewer" }, () => ({ isOffered: false })).catch(
    () => ({ isOffered: false }),
  );
  on("agent.spawn", { subagentType: "cerberus-gate:reviewer" }, async (_$, e, next) => {
    if (next.origin.plugin !== "cerberus-gate" || gate.active === undefined)
      return { deny: "Cerberus: reviewer is reserved for the active gate." };
    const result = await next(e);
    if (result.agentId !== undefined) {
      gate.reviewers.add(result.agentId);
      if (gate.active !== undefined) gate.active.agentId = result.agentId;
    }
    return result;
  }).catch(() => ({ deny: "Cerberus: reviewer spawn guard failed." }));
  on("turn.step", onStep).catch(stepFailure);
  on("turn.step", { agentId: /^/u }, onReviewerStep).catch(async function* (_$, e) {
    if (gate.active !== undefined && gate.active.agentId === e.agentId) gate.active.rawReview = "";
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, "");
  });
  on("turn.complete", onComplete);
  on("prompt.submit", onPrompt);
  on("tool.call", onTool).catch(() => ({ deny: "Cerberus: reviewer tool guard failed." }));
  on("tool.check", onCheck).catch(() => ({
    decision: "deny",
    reason: "Cerberus: permission guard failed.",
  }));
  on("turn.abort", async (_$, e, next) => {
    timer?.cancel();
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
    return next(e);
  });
  on("session.end", async (_$, e, next) => {
    timer?.cancel();
    reset(gate, "");
    return next(e);
  });
};
