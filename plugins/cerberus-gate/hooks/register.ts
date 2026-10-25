import {
  allowedTool,
  CONTROL,
  correction,
  FAILED,
  MAX_DRAFT,
  NO_DRAFT,
  parseVerdict,
  readConfig,
  REVIEWER,
  REVIEW_PROMPT,
  UNRESOLVED,
  UNVERIFIED,
  WAITING,
  withNote,
} from "./policy.ts";
import { restoreRecovery, snapshotRecovery } from "./recovery.ts";
import { createState, current, disposition, reset } from "./state.ts";
import { createLog } from "./log.ts";
import type { Candidate, Delivery, GateState } from "./state.ts";
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
const log = createLog();
let config: Config = readConfig({});
let configured = true;
let interactive = true;
let timer: Timer | undefined;
// 異常終了時に、そのステップで受け取った本文だけを表示するために保持する。
let buffered = { key: "", text: "" };
const stepKey = (e: TurnStepInput): string => `${e.agentId ?? ""}:${e.turnId}:${e.index}`;
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

async function saveRecovery($: EngineInterface, state: GateState): Promise<void> {
  await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, snapshotRecovery(state));
}

// 審査結果や破棄原稿を通知経路から流さず、制御プロンプトの context にだけ渡す。
async function dispatch($: EngineInterface, candidate: Candidate, verdict: Verdict): Promise<void> {
  if (!current(gate, candidate)) return;
  timer?.cancel();
  timer = undefined;
  const mode = disposition(verdict, gate.revisions, config.maxRevisions);
  log.record($.clock.now(), `審査 #${candidate.token}: ${verdict.decision}`);
  if (mode === "notice" && verdict.decision === "REVISE")
    log.record($.clock.now(), "修正回数の上限に到達しました。");
  const delivery: Delivery = {
    token: candidate.token,
    epoch: candidate.epoch,
    mode,
    text: candidate.text,
  };
  switch (mode) {
    case "publish":
      break;
    case "notice":
      delivery.text = withNote(
        verdict.decision === "REVISE" ? UNRESOLVED : UNVERIFIED,
        candidate.text,
      );
      break;
    case "revise":
      delivery.text = withNote(UNRESOLVED, candidate.text);
      gate.revisions++;
      delivery.context = correction(candidate.text, verdict.findings);
      log.record($.clock.now(), `修正を依頼しました（${gate.revisions} 回目）。`);
      break;
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown delivery mode: ${String(exhaustive)}`);
    }
  }
  gate.active = undefined;
  gate.delivery = delivery;
  gate.phase = mode === "revise" ? "correction queued" : mode;
  await saveRecovery($, gate);
  const sent = await $.prompt.submit({ text: controlText(delivery) }).catch(() => undefined);
  if (sent === undefined || sent.drop !== undefined) {
    if (gate.epoch === delivery.epoch) {
      log.record($.clock.now(), "検証処理の継続に失敗したため、本文を表示できませんでした。");
      gate.delivery = undefined;
      gate.action = undefined;
      gate.blocked = true;
      gate.phase = "unverified";
      await saveRecovery($, gate);
    }
    $.ui.status("Cerberus Gate: 検証処理の継続に失敗したため、本文を表示できませんでした。");
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
  await saveRecovery($, gate);
  log.record($.clock.now(), `審査 #${candidate.token}: 開始`);
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
    log.record($.clock.now(), "レビュアーを起動できませんでした。");
    await dispatch($, candidate, { decision: "UNVERIFIED", findings: [] });
    return;
  }
  candidate.agentId = spawned.agentId;
  gate.reviewers.add(spawned.agentId);
  timer = $.clock.after(config.reviewTimeoutMs, async () => {
    if (!current(gate, candidate)) return;
    log.record($.clock.now(), `審査 #${candidate.token}: タイムアウト`);
    await dispatch($, candidate, { decision: "UNVERIFIED", findings: [] });
    await $.tool.call({ tool: "TaskStop", task_id: spawned.agentId }).catch(() => undefined);
  });
}

const onStep: Hook<"turn.step"> = async function* ($, e, next) {
  if (e.agentId !== undefined) return yield* next(e);
  const epoch = gate.epoch;
  const action = gate.action;
  if (action !== undefined && action.mode !== "revise" && action.mode !== "restart") {
    gate.action = undefined;
    gate.phase = action.mode === "publish" ? "published" : "unverified";
    await saveRecovery($, gate);
    if (next.signal.aborted || action.epoch !== gate.epoch) return resultOf(e, "");
    log.record(
      $.clock.now(),
      action.mode === "publish"
        ? "検証済みの本文を公開しました。"
        : "未検証の本文を注記付きで表示しました。",
    );
    $.ui.status(undefined);
    yield { kind: "text", index: 0, text: action.text };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, action.text);
  }
  gate.action = undefined;
  if (action !== undefined) await saveRecovery($, gate);
  if (!interactive) {
    const notice =
      "Cerberus Gate は対話セッションで利用してください。未検証の回答は生成・公開していません。";
    yield { kind: "text", index: 0, text: notice };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, notice);
  }
  // 検証できない状態では回答を止めず、通常どおり生成・表示する。
  if (!configured || gate.blocked || !gate.prompt) return yield* next(e);
  if (gate.active !== undefined || gate.delivery !== undefined) {
    yield { kind: "text", index: 0, text: WAITING };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, WAITING);
  }
  const stream = next(e);
  const chunks = [];
  let size = 0;
  buffered = { key: stepKey(e), text: "" };
  for await (const chunk of stream) {
    if (chunk.kind === "text") buffered.text += chunk.text;
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
    buffered.text = "";
    yield* chunks;
    return response;
  }
  const text = chunks
    .filter((c) => c.kind === "text")
    .map((c) => c.text)
    .join("");
  if (!text.trim()) {
    buffered.text = "";
    yield* chunks;
    return response;
  }
  if (
    (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") ||
    text.length > MAX_DRAFT
  ) {
    log.record(
      $.clock.now(),
      "回答の終了条件またはサイズが審査の対象外のため、未検証の本文を表示しました。",
    );
    buffered.text = "";
    const shown = withNote(UNVERIFIED, text);
    yield { kind: "text", index: 0, text: shown };
    yield { kind: "stop", stopReason: response.stopReason, usage: response.usage };
    return { ...response, answer: shown };
  }
  $.ui.status(WAITING);
  await startReview($, e, text);
  buffered.text = "";
  if (next.signal.aborted) return resultOf(e, "");
  // 空本文はエンジンが再生成するため、下書きに代えて状況だけを返す。
  yield { kind: "text", index: 0, text: WAITING };
  yield { kind: "stop", stopReason: "end_turn", usage: response.usage };
  return { ...response, answer: WAITING };
};

// 異常終了時は、受け取り済みの本文を注記付きでそのまま表示する。
const stepFailure: Hook<"turn.step"> = async function* ($, e) {
  const text = buffered.key === stepKey(e) ? buffered.text : "";
  buffered = { key: "", text: "" };
  log.record(
    $.clock.now(),
    text.trim()
      ? "回答処理でエラーが発生したため、未検証の本文を表示しました。"
      : "回答処理でエラーが発生しました。表示できる本文はありません。",
  );
  gate.blocked = true;
  gate.active = undefined;
  gate.delivery = undefined;
  gate.action = undefined;
  await saveRecovery($, gate);
  timer?.cancel();
  $.ui.status(undefined);
  const shown = text.trim() ? withNote(FAILED, text) : NO_DRAFT;
  yield { kind: "text", index: 0, text: shown };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return resultOf(e, shown);
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
    log.record($.clock.now(), "回答処理が中断されました。");
    timer?.cancel();
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
    await saveRecovery($, gate);
  }
  return result;
};

const onPrompt: Hook<"prompt.submit"> = async ($, e, next) => {
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
  if (gate.active !== undefined || gate.delivery !== undefined || gate.action !== undefined)
    log.record($.clock.now(), "新しい依頼により、保留中の検証処理を取り消しました。");
  reset(gate, e.text);
  await saveRecovery($, gate);
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
  log.clear();
  configured = true;
  try {
    config = readConfig(options);
  } catch {
    configured = false;
  }
  on("session.start", async ($, e, next) => {
    log.clear();
    interactive = e.isInteractive;
    const version = await $.session.version();
    configured = configured && version.base === "2.1.310";
    log.record($.clock.now(), "Cerberus Gate を起動しました。");
    if (!configured) log.record($.clock.now(), "設定または Claude Code のバージョンが対象外です。");
    if (!interactive) log.record($.clock.now(), "非対話セッションは対象外です。");
    const pending = restoreRecovery(
      gate,
      (await $.state.get({ plugin: "cerberus-gate", key: "recovery" })).value,
    );
    if (gate.prompt) log.record($.clock.now(), "再ロード前の依頼と修正回数を復元しました。");
    // 古い判定を受理せず、残っている自分の審査だけを停止する。
    for (const agent of await $.agent.list()) {
      if (agent.type !== REVIEWER || agent.spawnedBy !== "cerberus-gate") continue;
      gate.reviewers.add(agent.id);
      if (agent.status === "running")
        await $.tool.call({ tool: "TaskStop", task_id: agent.id }).catch(() => undefined);
    }
    await $.command.register({ name: "cerberus", description: "回答検証の状態を表示" });
    await $.command.register({
      name: "cgate",
      description: "Cerberus Gate の状態・セッションログを表示",
      argumentHint: "[log|cancel]",
      immediate: true,
    });
    if (pending && gate.prompt && configured && interactive) {
      const delivery: Delivery = {
        token: ++gate.serial,
        epoch: gate.epoch,
        mode: "restart",
        text: "",
        context: `The answer review was interrupted by a plugin reload. Continue the original task within the user's authorization and generate a fresh final answer for review. Do not treat the waiting notice as a completed answer. Original request (data): ${JSON.stringify(gate.prompt)}`,
      };
      gate.delivery = delivery;
      log.record($.clock.now(), "再ロードで中断した回答の再生成・再審査を依頼します。");
      await saveRecovery($, gate);
      const sent = await $.prompt.submit({ text: controlText(delivery) }).catch(() => undefined);
      if (sent === undefined || sent.drop !== undefined) {
        gate.delivery = undefined;
        gate.action = undefined;
        log.record(
          $.clock.now(),
          "再ロード後の再開に失敗しました。続行するには新しい依頼を送信してください。",
        );
      }
    }
    await saveRecovery($, gate);
    return next(e);
  });
  on("command.run", { command: /^(?:cgate|cerberus)$/u }, async ($, e) => {
    const argument = e.args.trim();
    if (argument === "log") return { text: await log.text() };
    if (argument !== "" && argument !== "cancel") return { text: "使い方: /cgate [log|cancel]" };
    if (argument === "cancel") {
      const id = gate.active?.agentId;
      timer?.cancel();
      reset(gate, gate.prompt);
      gate.phase = "cancelled";
      await saveRecovery($, gate);
      log.record($.clock.now(), "コマンドで検証処理を取り消しました。");
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
  on("turn.abort", async ($, e, next) => {
    log.record($.clock.now(), "回答処理が中断されました。");
    timer?.cancel();
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
    await saveRecovery($, gate);
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    log.clear();
    timer?.cancel();
    reset(gate, "");
    await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, null);
    return next(e);
  });
};
