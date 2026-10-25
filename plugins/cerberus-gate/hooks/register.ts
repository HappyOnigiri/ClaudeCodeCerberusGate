import {
  allowedTool,
  CONTROL,
  correction,
  FAILED,
  MAX_DRAFT,
  NO_DRAFT,
  readConfig,
  parseVerdict,
  REVIEWER,
  UNRESOLVED,
  UNVERIFIED,
  WAITING,
  withNote,
} from "./policy.ts";
import { restoreRecovery, snapshotRecovery } from "./recovery.ts";
import { createState, current, disposition, reset } from "./state.ts";
import { MAX_ROUNDS, MAX_EVIDENCE, REVIEW_SYSTEM, reviewTools, toolRequest } from "./review.ts";
import type { ReviewRequest } from "./review.ts";
import { createLog } from "./log.ts";
import type { Candidate, Delivery, GateState } from "./state.ts";
import type { Config, Verdict } from "./policy.ts";
import type {
  EngineInterface,
  Hook,
  Register,
  TurnStepInput,
  TurnStepResult,
  ToolCallArgs,
  ToolCallResult,
} from "claude-code";

const gate = createState();
const log = createLog();
let config: Config = readConfig({});
let configured = true;
let interactive = true;
let pendingEnabled: boolean | undefined;
const enabled = (): boolean => gate.sessionEnabled ?? config.enabled;
const status = (): string =>
  `Cerberus Gate: ${enabled() ? "on" : "off"} (${gate.sessionEnabled === undefined ? "saved" : "session"}); ${gate.phase}; corrections=${gate.revisions}`;
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

async function applyEnabled($: EngineInterface, desired: boolean | undefined, persist: boolean) {
  if (persist) {
    try {
      const result = await $.config.set({
        key: "cerberus-gate.enabled",
        value: desired ?? config.enabled,
      });
      if (result.deny !== undefined || typeof result.value !== "boolean")
        return { ok: false, text: "Cerberus Gate: 有効・無効の設定を保存できませんでした。" };
      config = { ...config, enabled: result.value };
      gate.sessionEnabled = undefined;
    } catch {
      return { ok: false, text: "Cerberus Gate: 有効・無効の設定を保存できませんでした。" };
    }
  } else gate.sessionEnabled = desired;
  const turnId = gate.active?.turnId;
  const pending =
    gate.active !== undefined || gate.delivery !== undefined || gate.action !== undefined;
  if (!enabled() && pending) {
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
    $.ui.status(undefined);
  }
  await saveRecovery($, gate);
  log.record($.clock.now(), status());
  if (!enabled() && turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined);
  return {
    ok: true,
    text:
      status() +
      (!enabled() && pending
        ? " 保留中の回答を取り消しました。新しい依頼を送信してください。"
        : ""),
  };
}

// Submission is deferred so it cannot wait on the turn holding the unpublished answer.
function queueContinuation($: EngineInterface, delivery: Delivery): void {
  $.clock.after(0, async () => {
    if (gate.delivery !== delivery || gate.epoch !== delivery.epoch) return;
    const sent = await $.prompt.submit({ text: controlText(delivery) }).catch(() => undefined);
    if (gate.epoch !== delivery.epoch || gate.serial !== delivery.token) return;
    if (sent !== undefined && sent.drop === undefined) return;
    gate.delivery = undefined;
    gate.action = undefined;
    gate.blocked = true;
    gate.phase = "unverified";
    await saveRecovery($, gate);
    if (delivery.mode === "restart") {
      log.record(
        $.clock.now(),
        "再ロード後の再開に失敗しました。続行するには新しい依頼を送信してください。",
      );
    } else {
      log.record($.clock.now(), "修正依頼の送信に失敗したため、本文を表示できませんでした。");
      $.ui.toast("Cerberus Gate: 修正依頼の送信に失敗したため、本文を表示できませんでした。", {
        timeoutMs: 3000,
      });
    }
  });
}

// This is the sole dynamic tool-call boundary, checked statically and by tool.call/tool.check hooks.
async function callReviewTool($: EngineInterface, call: ReviewRequest): Promise<ToolCallResult> {
  if (!allowedTool(call.tool, config)) return { deny: "Cerberus: unapproved review tool." };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine validates each dynamic tool schema after the checked envelope and allow-list
  return $.tool.call({ ...call.input, tool: call.tool } as ToolCallArgs);
}

const unverified = (): Verdict => ({ decision: "UNVERIFIED", findings: [] });
// Cancellation must also release the main step while a read-only tool is still in flight.
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error("Review stopped"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function review(
  $: EngineInterface,
  reviewConfig: Config,
  candidate: Candidate,
  request: string,
  model: string,
  effort: TurnStepInput["effort"],
): Promise<Verdict> {
  const signal = candidate.controller.signal;
  try {
    const started = await $.clock.now();
    const tools = reviewTools(await $.tool.list(), reviewConfig);
    const evidence: { tool: string; input: Record<string, unknown>; result: string }[] = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const remaining = reviewConfig.reviewTimeoutMs - ((await $.clock.now()) - started);
      if (remaining <= 0) candidate.timedOut = true;
      if (signal.aborted || candidate.timedOut) return unverified();
      const response = await $.model.complete(
        {
          model: reviewConfig.reviewerModel === "inherit" ? model : reviewConfig.reviewerModel,
          effort:
            reviewConfig.reviewerEffort === "inherit"
              ? typeof effort === "number"
                ? undefined
                : effort
              : reviewConfig.reviewerEffort,
          system: REVIEW_SYSTEM,
          prompt: JSON.stringify({
            request,
            conversation: candidate.context,
            unpublishedDraft: candidate.text,
            tools,
            evidence,
          }),
          maxTokens: 4096,
          timeoutMs: remaining,
        },
        { signal },
      );
      if (signal.aborted || !response.isAnswered || response.text.length > MAX_DRAFT)
        return unverified();
      if ((await $.clock.now()) - started >= reviewConfig.reviewTimeoutMs) {
        candidate.timedOut = true;
        return unverified();
      }
      const call = toolRequest(response.text);
      if (call === undefined) return parseVerdict(response.text);
      if (!tools.some((tool) => tool.name === call.tool) || !allowedTool(call.tool, reviewConfig))
        return unverified();
      const result = await cancellable(callReviewTool($, call), signal);
      if (signal.aborted || result.deny !== undefined || result.isError) return unverified();
      if (reviewConfig.mcpTools.includes(call.tool) && result.isReadOnly !== true)
        return unverified();
      evidence.push({
        tool: call.tool,
        input: call.input,
        result: (result.text ?? JSON.stringify(result.result) ?? "").slice(0, MAX_EVIDENCE),
      });
      if (JSON.stringify(evidence).length > MAX_EVIDENCE) return unverified();
    }
  } catch {
    // Invalid JSON, permission failures and unavailable evidence never become PASS.
  }
  return unverified();
}

// Regular reviews queue only REVISE; reload recovery can also request a fresh answer.
async function finishReview(
  $: EngineInterface,
  candidate: Candidate,
  verdict: Verdict,
): Promise<string> {
  const mode = disposition(verdict, gate.revisions, config.maxRevisions);
  log.record($.clock.now(), `審査 #${candidate.token}: ${verdict.decision}`);
  gate.active = undefined;
  if (mode === "revise") {
    gate.revisions++;
    const delivery: Delivery = {
      token: candidate.token,
      epoch: candidate.epoch,
      context: correction(candidate.text, verdict.findings),
      mode: "revise",
    };
    gate.delivery = delivery;
    gate.phase = "correction queued";
    log.record($.clock.now(), `修正を依頼しました（${gate.revisions} 回目）。`);
    await saveRecovery($, gate);
    queueContinuation($, delivery);
    return WAITING;
  }
  switch (mode) {
    case "publish":
      gate.phase = "published";
      log.record($.clock.now(), "検証済みの本文を公開しました。");
      await saveRecovery($, gate);
      return candidate.text;
    case "notice":
      gate.phase = "unverified";
      if (verdict.decision === "REVISE")
        log.record($.clock.now(), "修正回数の上限に到達しました。");
      log.record($.clock.now(), "未検証の本文を注記付きで表示しました。");
      await saveRecovery($, gate);
      return withNote(verdict.decision === "REVISE" ? UNRESOLVED : UNVERIFIED, candidate.text);
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown delivery mode: ${String(exhaustive)}`);
    }
  }
}

async function verify(
  $: EngineInterface,
  e: TurnStepInput,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const epoch = gate.epoch;
  const candidate: Candidate = {
    token: ++gate.serial,
    turnId: e.turnId,
    epoch: gate.epoch,
    text,
    context: "",
    controller: new AbortController(),
    timedOut: false,
  };
  if (signal.aborted || epoch !== gate.epoch) return "";
  const abort = () => candidate.controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  gate.active = candidate;
  gate.phase = "reviewing";
  log.record($.clock.now(), `審査 #${candidate.token}: 開始`);
  const timer = $.clock.after(config.reviewTimeoutMs, () => {
    if (!current(gate, candidate)) return;
    candidate.timedOut = true;
    candidate.controller.abort();
  });
  try {
    await saveRecovery($, gate);
    candidate.context = JSON.stringify(await $.session.messages({ as: "api" })).slice(-80_000);
    if (!current(gate, candidate) || signal.aborted) return "";
    let verdict = await review($, config, candidate, gate.prompt, e.model, e.effort);
    if (!current(gate, candidate) || signal.aborted) return "";
    if (candidate.timedOut) {
      log.record($.clock.now(), `審査 #${candidate.token}: タイムアウト`);
      verdict = { decision: "UNVERIFIED", findings: [] };
    }
    return await finishReview($, candidate, verdict);
  } finally {
    timer.cancel();
    signal.removeEventListener("abort", abort);
    if (gate.active === candidate) gate.active = undefined;
  }
}

const onStep: Hook<"turn.step"> = async function* ($, e, next) {
  if (e.agentId !== undefined) return yield* next(e);
  const epoch = gate.epoch;
  if (gate.action !== undefined) {
    gate.action = undefined;
    await saveRecovery($, gate);
  }
  if (!enabled()) return yield* next(e);
  if (!interactive) {
    const text =
      "Cerberus Gate は対話セッションで利用してください。未検証の回答は生成・公開していません。";
    yield { kind: "text", index: 0, text };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return resultOf(e, text);
  }
  if (!configured || gate.blocked || !gate.prompt) return yield* next(e);
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
  const text = chunks
    .filter((c) => c.kind === "text")
    .map((c) => c.text)
    .join("");
  if (
    !enabled() ||
    response.toolUses.length > 0 ||
    chunks.some((c) => c.kind === "tool") ||
    !text.trim()
  ) {
    buffered.text = "";
    yield* chunks;
    return response;
  }
  let shown: string;
  if (
    (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") ||
    text.length > MAX_DRAFT
  ) {
    log.record(
      $.clock.now(),
      "回答の終了条件またはサイズが審査の対象外のため、未検証の本文を表示しました。",
    );
    shown = withNote(UNVERIFIED, text);
  } else {
    $.ui.status(WAITING);
    shown = await verify($, e, text, next.signal);
    $.ui.status(undefined);
  }
  if (buffered.key === stepKey(e)) buffered.text = "";
  if (next.signal.aborted || epoch !== gate.epoch || !shown) return resultOf(e, "");
  yield { kind: "text", index: 0, text: shown };
  yield { kind: "stop", stopReason: response.stopReason, usage: response.usage };
  return { ...response, answer: shown };
};

const stepFailure: Hook<"turn.step"> = async function* ($, e, next) {
  const text = buffered.key === stepKey(e) ? buffered.text : "";
  buffered = { key: "", text: "" };
  if (next.signal.aborted) return resultOf(e, "");
  log.record(
    $.clock.now(),
    text.trim()
      ? "回答処理でエラーが発生したため、未検証の本文を表示しました。"
      : "回答処理でエラーが発生しました。表示できる本文はありません。",
  );
  gate.active?.controller.abort();
  gate.blocked = true;
  gate.active = undefined;
  gate.delivery = undefined;
  gate.action = undefined;
  await saveRecovery($, gate);
  $.ui.status(undefined);
  const shown = text.trim() ? withNote(FAILED, text) : NO_DRAFT;
  yield { kind: "text", index: 0, text: shown };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return resultOf(e, shown);
};

const onPrompt: Hook<"prompt.submit"> = async ($, e, next) => {
  if (e.origin.kind === "plugin" && e.origin.name === "cerberus-gate") {
    const delivery = gate.delivery;
    if (delivery === undefined || e.text !== controlText(delivery) || delivery.epoch !== gate.epoch)
      return { drop: "Cerberus: 古い検証処理を破棄しました。" };
    gate.action = delivery;
    gate.delivery = undefined;
    await saveRecovery($, gate);
    return next({ ...e, context: [...(e.context ?? []), delivery.context] });
  }
  // Suppress late notifications from reviewers left by an older plugin on reload.
  if (
    (e.origin.kind === "task-notification" ||
      e.origin.kind === "peer" ||
      e.origin.kind === "peer-send-message") &&
    [...gate.reviewers].some((id) => e.text.includes(id))
  )
    return { drop: "Cerberus: 検証結果を処理済みです。" };
  if (gate.active !== undefined || gate.delivery !== undefined)
    log.record($.clock.now(), "新しい依頼により、保留中の検証処理を取り消しました。");
  reset(gate, e.text);
  await saveRecovery($, gate);
  $.ui.status(undefined);
  return next(e);
};

const onTool: Hook<"tool.call"> = async (_$, e, next) => {
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId)) {
    if (e.tool === "SubagentHandback")
      return next({ ...e, message: "Cerberus Gate reviewer: completed." });
    return { deny: "Cerberus: stale reviewer stopped." };
  }
  if (next.origin.plugin !== "cerberus-gate") return next(e);
  if (e.tool === "TaskStop" && e.task_id !== undefined && gate.reviewers.has(e.task_id))
    return next(e);
  if (
    gate.active === undefined ||
    gate.active.controller.signal.aborted ||
    !allowedTool(e.tool, config)
  )
    return { deny: "Cerberus reviewer: only approved read-only tools are permitted." };
  return next(e);
};
const onCheck: Hook<"tool.check"> = async (_$, e, next) => {
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId))
    return e.tool === "SubagentHandback"
      ? next(e)
      : { decision: "deny", reason: "Cerberus: stale reviewer stopped." };
  if (next.origin.plugin !== "cerberus-gate") return next(e);
  if (
    e.tool === "TaskStop" &&
    typeof e.input === "object" &&
    e.input !== null &&
    "task_id" in e.input &&
    typeof e.input.task_id === "string" &&
    gate.reviewers.has(e.input.task_id)
  )
    return next(e);
  if (
    gate.active === undefined ||
    gate.active.controller.signal.aborted ||
    !allowedTool(e.tool, config) ||
    (config.mcpTools.includes(e.tool) && e.isReadOnly !== true)
  )
    return {
      decision: "deny",
      reason: "Cerberus: connector calls must be explicitly allowed and read-only.",
    };
  return next(e);
};

export const register: Register = (on, options) => {
  gate.sessionEnabled = undefined;
  pendingEnabled = undefined;
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
    configured = configured && (await $.session.version()).base === "2.1.310";
    log.record($.clock.now(), "Cerberus Gate を起動しました。");
    if (!configured) log.record($.clock.now(), "設定または Claude Code のバージョンが対象外です。");
    if (!interactive) log.record($.clock.now(), "非対話セッションは対象外です。");
    const pending = restoreRecovery(
      gate,
      (await $.state.get({ plugin: "cerberus-gate", key: "recovery" })).value,
    );
    if (gate.prompt) log.record($.clock.now(), "再ロード前の依頼と修正回数を復元しました。");
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
      argumentHint: "[on|off|reset|model|log|cancel]",
      immediate: true,
    });
    if (pending && gate.prompt && configured && interactive && enabled()) {
      const delivery: Delivery = {
        token: ++gate.serial,
        epoch: gate.epoch,
        mode: "restart",
        context: `The answer review was interrupted by a plugin reload. Continue the original task within the user's authorization and generate a fresh final answer for review. Do not treat the waiting notice as a completed answer. Original request (data): ${JSON.stringify(gate.prompt)}`,
      };
      gate.delivery = delivery;
      log.record($.clock.now(), "再ロードで中断した回答の再生成・再審査を依頼します。");
      queueContinuation($, delivery);
    }
    await saveRecovery($, gate);
    return next(e);
  });
  on("command.run", { command: /^(?:cgate|cerberus)$/u }, async ($, e) => {
    const argument = e.args.trim();
    if (argument === "on" || argument === "off") {
      pendingEnabled = argument === "on";
      await $.ui.open({
        id: "enabled-scope",
        title: "有効・無効の適用範囲",
        focus: true,
        closeOnEscape: true,
      });
      return {};
    }
    if (argument === "reset") {
      pendingEnabled = undefined;
      return { text: (await applyEnabled($, undefined, false)).text };
    }
    if (argument === "model") {
      await $.ui.open({
        id: "reviewer-model",
        title: "検査用モデル・effort",
        focus: true,
        closeOnEscape: true,
      });
      return {};
    }
    if (argument === "log") return { text: await log.text() };
    if (argument !== "" && argument !== "cancel")
      return { text: "使い方: /cgate [on|off|reset|model|log|cancel]" };
    if (argument === "cancel") {
      const turnId = gate.active?.turnId;
      reset(gate, gate.prompt);
      gate.phase = "cancelled";
      await saveRecovery($, gate);
      $.ui.status(undefined);
      log.record($.clock.now(), "コマンドで検証処理を取り消しました。");
      if (turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined);
    }
    return { text: status() };
  });
  on("ui.render", { component: "Pane", requestId: "enabled-scope" }, ($, e) => {
    const desired = pendingEnabled;
    if (e.surface === "mobile" || desired === undefined) {
      const { Text } = $.ui.resolve(e);
      return Text({
        children: "ターミナルで /cgate on または /cgate off を実行して適用範囲を選んでください。",
      });
    }
    const { Select } = $.ui.resolve(e);
    return Select({
      key: `enabled-scope-${desired}`,
      label: `回答検証を${desired ? "有効" : "無効"}にする範囲`,
      options: [
        { value: "session", label: "このセッションだけ" },
        { value: "saved", label: "設定に保存（次回以降も適用）" },
      ],
      value: "session",
      autoFocus: true,
      onSelect: async (value) => {
        if (pendingEnabled !== desired || (value !== "session" && value !== "saved")) return;
        const result = await applyEnabled($, desired, value === "saved");
        $.ui.toast(result.text, { timeoutMs: 3000 });
        if (result.ok) {
          pendingEnabled = undefined;
          await $.ui.close({ id: "enabled-scope" });
        }
      },
    });
  });
  on("ui.render", { component: "Pane", requestId: "reviewer-model" }, ($, e) => {
    if (e.surface === "mobile") {
      const { Text } = $.ui.resolve(e);
      return Text({ children: "検査用モデル・effort は /config で変更してください。" });
    }
    const { Select } = $.ui.resolve(e);
    return Select({
      key: "reviewer-model",
      label: "検査用モデル",
      options: [
        ...new Set(["inherit", "haiku", "sonnet", "opus", "fable", config.reviewerModel]),
      ].map((value) => ({ value })),
      value: config.reviewerModel,
      autoFocus: true,
      onSelect: async (value) => {
        try {
          const result = await $.config.set({ key: "cerberus-gate.reviewerModel", value });
          if (result.deny !== undefined) {
            $.ui.toast(`Cerberus Gate: モデルを保存できませんでした。${result.deny}`, {
              timeoutMs: 3000,
            });
            return;
          }
          config = readConfig({
            ...options,
            enabled: config.enabled,
            reviewerModel: result.value,
            reviewerEffort: config.reviewerEffort,
          });
          $.ui.toast(`Cerberus Gate: 検査用モデルを ${config.reviewerModel} に設定しました。`, {
            timeoutMs: 3000,
          });
          await $.ui.close({ id: "reviewer-model" });
          await $.ui.open({
            id: "reviewer-effort",
            title: "検査用 effort",
            focus: true,
            closeOnEscape: true,
          });
        } catch {
          $.ui.toast("Cerberus Gate: モデルを保存できませんでした。", { timeoutMs: 3000 });
        }
      },
    });
  });
  on("ui.render", { component: "Pane", requestId: "reviewer-effort" }, ($, e) => {
    if (e.surface === "mobile") {
      const { Text } = $.ui.resolve(e);
      return Text({ children: "検査用 effort は /config で変更してください。" });
    }
    const { Select } = $.ui.resolve(e);
    return Select({
      key: "reviewer-effort",
      label: `検査用 effort（モデル: ${config.reviewerModel}）`,
      options: ["inherit", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value })),
      value: config.reviewerEffort,
      autoFocus: true,
      onSelect: async (value) => {
        try {
          const result = await $.config.set({ key: "cerberus-gate.reviewerEffort", value });
          if (result.deny !== undefined) {
            $.ui.toast(`Cerberus Gate: effort を保存できませんでした。${result.deny}`, {
              timeoutMs: 3000,
            });
            return;
          }
          config = readConfig({
            ...options,
            enabled: config.enabled,
            reviewerModel: config.reviewerModel,
            reviewerEffort: result.value,
          });
          $.ui.toast(`Cerberus Gate: 検査用 effort を ${config.reviewerEffort} に設定しました。`, {
            timeoutMs: 3000,
          });
          await $.ui.close({ id: "reviewer-effort" });
        } catch {
          $.ui.toast("Cerberus Gate: effort を保存できませんでした。", { timeoutMs: 3000 });
        }
      },
    });
  });
  on("agent.offer", { agent: REVIEWER }, () => ({ isOffered: false })).catch(() => ({
    isOffered: false,
  }));
  on("agent.spawn", { subagentType: REVIEWER }, () => ({ deny: "Cerberus: reviews run inline." }));
  on("turn.step", onStep).catch(stepFailure);
  on("prompt.submit", onPrompt);
  on("tool.call", onTool).catch(() => ({ deny: "Cerberus: reviewer tool guard failed." }));
  on("tool.check", onCheck).catch(() => ({
    decision: "deny",
    reason: "Cerberus: permission guard failed.",
  }));
  on("turn.abort", async ($, e, next) => {
    log.record($.clock.now(), "回答処理が中断されました。");
    reset(gate, gate.prompt);
    gate.phase = "cancelled";
    await saveRecovery($, gate);
    $.ui.status(undefined);
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    log.clear();
    reset(gate, "");
    gate.sessionEnabled = undefined;
    pendingEnabled = undefined;
    await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, null);
    return next(e);
  });
};
