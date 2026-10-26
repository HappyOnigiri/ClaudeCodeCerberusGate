import {
  correction,
  FAILED,
  MAX_DRAFT,
  NO_DRAFT,
  PASSED,
  readConfig,
  diagnoseVerdict,
  REVIEWER,
  revising,
  UNRESOLVED,
  UNVERIFIED,
  WAITING,
} from "./policy.ts";
import { restoreRecovery, snapshotRecovery } from "./recovery.ts";
import {
  controlText,
  createState,
  current,
  disposition,
  hidden,
  ownTask,
  rememberTask,
  requestOf,
  reset,
  resultOf,
  staleNotification,
} from "./state.ts";
import {
  MAX_ROUNDS,
  MAX_EVIDENCE,
  backgroundTask,
  reviewModelRequest,
  reviewTools,
  toolRequest,
  reviewEvidence,
  reviewFailureReason,
  cancellable,
} from "./review.ts";
import type { Evidence, ReviewRequest } from "./review.ts";
import { createDebug } from "./debug.ts";
import { createLog } from "./log.ts";
import type { Candidate, Delivery, GateState, Shown } from "./state.ts";
import type { Config, Verdict } from "./policy.ts";
import type {
  EngineInterface,
  Hook,
  Register,
  TurnStepInput,
  ToolCallArgs,
  ToolCallResult,
} from "claude-code";

const gate = createState();
const log = createLog();
let debug = createDebug();
let debugQueue: Promise<void> = Promise.resolve();
function debugFailure($: EngineInterface, error: unknown): void {
  debug.failed(error);
  try {
    log.record(
      $.clock.now(),
      "デバッグログの保存に失敗しました。/cgate log で保存状態を確認してください。",
    );
    $.ui.toast("Cerberus Gate: デバッグログの保存に失敗しました。", { timeoutMs: 3000 });
  } catch {
    /* Diagnostic notifications must not interrupt publication. */
  }
}
function showNote($: EngineInterface, note: string): void {
  try {
    $.ui.log(note);
  } catch (error) {
    debug.record("notice.failed", { note, error }, "error");
  }
}
async function flushDebug(
  $: EngineInterface,
  logger = debug,
  force = false,
  signal?: AbortSignal,
): Promise<void> {
  // A cancelled turn cannot launch helpers. Keep its tail for the next live dispatch.
  if (!logger.ready()) return;
  debugQueue = debugQueue.then(async () => {
    if ((signal?.aborted || gate.phase === "cancelled") && !force) return;
    const records = logger.take();
    if (!records.length) return;
    try {
      const result = await $.process.run(
        ["node", `${$.plugin.root}/hooks/debug-log.mts`, "append"],
        {
          stdin: JSON.stringify({ ...logger.identity(), records }),
          timeoutMs: 1000,
        },
      );
      if (result.exitCode !== 0) throw result;
    } catch (error) {
      if (logger === debug) debugFailure($, error);
    }
  });
  await debugQueue;
}
async function initializeDebug($: EngineInterface, details: unknown): Promise<void> {
  debug = createDebug();
  const identity = debug.start(await $.session.id());
  let pluginVersion: unknown;
  try {
    const result = await $.process.run(
      ["node", `${$.plugin.root}/hooks/debug-log.mts`, "initialize"],
      {
        stdin: JSON.stringify(identity),
        timeoutMs: 1000,
      },
    );
    if (result.exitCode !== 0 || result.isStdoutTruncated) throw result;
    const location = JSON.parse(result.stdout);
    if (
      typeof location.events !== "string" ||
      typeof location.index !== "string" ||
      typeof location.directory !== "string"
    )
      throw new Error("Invalid debug location");
    debug.saved(location);
    pluginVersion = location.pluginVersion;
  } catch (error) {
    debugFailure($, error);
  }
  debug.record("session.start", {
    details,
    config,
    configured,
    cwd: await $.session.cwd(),
    version: await $.session.version(),
    pluginRoot: $.plugin.root,
    pluginVersion,
  });
  await flushDebug($);
}
let config: Config = readConfig({});
let configured = true;
let configError: unknown;
let interactive = true;
let pendingEnabled: boolean | undefined;
const enabled = (): boolean => gate.sessionEnabled ?? config.enabled;
const status = (): string =>
  `Cerberus Gate: ${enabled() ? "on" : "off"} (${gate.sessionEnabled === undefined ? "saved" : "session"}); ${gate.phase}; corrections=${gate.revisions}`;
let buffered = { key: "", text: "" };
const stepKey = (e: TurnStepInput): string => `${e.agentId ?? ""}:${e.turnId}:${e.index}`;

async function saveRecovery(
  $: EngineInterface,
  state: GateState,
  signal?: AbortSignal,
): Promise<void> {
  debug.record("state.saved", { ...snapshotRecovery(state), phase: state.phase });
  await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, snapshotRecovery(state));
  await flushDebug($, debug, false, signal);
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
    } catch (error) {
      debug.record("settings.failed", { setting: "enabled", error }, "error");
      await flushDebug($);
      return { ok: false, text: "Cerberus Gate: 有効・無効の設定を保存できませんでした。" };
    }
  } else gate.sessionEnabled = desired;
  const turnId = gate.active?.turnId;
  const pending =
    gate.active !== undefined || gate.delivery !== undefined || gate.action !== undefined;
  if (!enabled() && pending) {
    reset(gate, gate.prompt, gate.marker);
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
    const operationId = debug.operation();
    debug.record("delivery.start", { operationId, ...delivery });
    await flushDebug($);
    const sent = await $.prompt.submit({ text: controlText(delivery) }).catch((error: unknown) => {
      debug.record("delivery.failed", { operationId, error }, "error");
      return undefined;
    });
    debug.record("delivery.complete", {
      operationId,
      result: sent,
      stale: gate.epoch !== delivery.epoch || gate.serial !== delivery.token,
    });
    await flushDebug($);
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

// The sole dynamic tool-call boundary forwards only tools advertised for this review.
async function callReviewTool(
  $: EngineInterface,
  call: ReviewRequest,
  tools: ReadonlySet<string>,
): Promise<ToolCallResult> {
  if (!tools.has(call.tool)) return { deny: "Cerberus: tool absent from review session." };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine validates each dynamic tool schema after the checked envelope and session tool list
  return $.tool.call({ ...call.input, tool: call.tool } as ToolCallArgs);
}

// The reviewer's command left in the background would notify the main session after the review.
// Stopping it is the Mod's own cleanup; dropping its notification in onPrompt is the guarantee.
async function stopReviewerTask($: EngineInterface, logger: typeof debug, id: string) {
  rememberTask(gate, id);
  const operationId = logger.operation();
  logger.record("task.stop.start", { operationId, taskId: id });
  const result = await $.tool
    .call({ tool: "TaskStop", task_id: id })
    .catch((error: unknown) => ({ error }));
  logger.record("task.stop.complete", { operationId, taskId: id, result });
  await saveRecovery($, gate).catch(() => undefined);
}

const unverified = (): Verdict => ({ decision: "UNVERIFIED", findings: [] });

async function review(
  $: EngineInterface,
  reviewConfig: Config,
  candidate: Candidate,
  request: string,
  model: string,
  effort: TurnStepInput["effort"],
): Promise<Verdict> {
  const signal = candidate.controller.signal;
  const logger = debug;
  const correlation = {
    turnId: candidate.turnId,
    stepIndex: candidate.stepIndex,
    epoch: candidate.epoch,
    reviewToken: candidate.token,
  };
  let stage = "tool.list";
  let activeOperationId = "";
  const fail = (reason: string): Verdict => {
    logger.record("review.unverified", { ...correlation, reason });
    return unverified();
  };
  try {
    const started = await $.clock.now();
    const tools = reviewTools(await $.tool.list());
    const names = new Set(tools.map((tool) => tool.name));
    const evidence: Evidence[] = [];
    let errors = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const remaining = reviewConfig.reviewTimeoutMs - ((await $.clock.now()) - started);
      if (remaining <= 0) candidate.timedOut = true;
      if (signal.aborted || candidate.timedOut)
        return fail(signal.aborted ? "cancelled" : "timeout");
      const operationId = logger.operation();
      stage = "model";
      activeOperationId = operationId;
      const modelRequest = reviewModelRequest(reviewConfig, {
        model,
        effort,
        request,
        workingDirectory: await $.session.cwd(),
        candidate,
        tools,
        evidence,
        remaining,
      });
      logger.record("model.start", {
        ...correlation,
        operationId,
        round,
        remaining,
        request: modelRequest,
      });
      await flushDebug($, logger, false, signal);
      const modelStarted = await $.clock.now();
      const response = await cancellable(
        $.model.complete(modelRequest, { signal }).then((result) => {
          if (signal.aborted) {
            logger.record("model.discarded", { ...correlation, operationId, response: result });
          }
          return result;
        }),
        signal,
      );
      logger.record("model.complete", {
        ...correlation,
        operationId,
        round,
        response,
        elapsedMs: (await $.clock.now()) - modelStarted,
      });
      await flushDebug($, logger, false, signal);
      if (signal.aborted) return fail("cancelled");
      if (!response.isAnswered || !response.text) return fail("model_empty_or_failed");
      if (response.text.length > MAX_DRAFT) return fail("response_size_limit");
      if ((await $.clock.now()) - started >= reviewConfig.reviewTimeoutMs) {
        candidate.timedOut = true;
        return fail("timeout");
      }
      stage = "parse";
      const call = toolRequest(response.text);
      if (call === undefined) {
        const parsed = diagnoseVerdict(response.text);
        logger.record("verdict.parsed", { ...correlation, ...parsed });
        return parsed.verdict;
      }
      stage = "tool";
      const toolOperationId = logger.operation();
      activeOperationId = toolOperationId;
      logger.record("tool.start", { ...correlation, operationId: toolOperationId, call });
      await flushDebug($, logger, false, signal);
      const result = await cancellable(
        callReviewTool($, call, names).then(async (value) => {
          logger.record(signal.aborted ? "tool.discarded" : "tool.complete", {
            ...correlation,
            operationId: toolOperationId,
            result: value,
          });
          const task = backgroundTask(value);
          if (task !== undefined) await stopReviewerTask($, logger, task.id);
          return value;
        }),
        signal,
      );
      await flushDebug($, logger, false, signal);
      if (signal.aborted) return fail("cancelled");
      const outcome = reviewEvidence(call, result, errors);
      if ("reason" in outcome) return fail(outcome.reason);
      errors = outcome.errors;
      evidence.push(outcome.entry);
      if (JSON.stringify(evidence).length > MAX_EVIDENCE) return fail("evidence_size_limit");
    }
  } catch (error) {
    logger.record(
      "review.failed",
      {
        ...correlation,
        stage,
        operationId: activeOperationId,
        reason: reviewFailureReason(stage, error, signal.aborted, candidate.timedOut),
        error,
      },
      "error",
    );
    return unverified();
  }
  return fail("round_limit");
}

// Regular reviews queue only REVISE; reload recovery can also request a fresh answer.
async function finishReview(
  $: EngineInterface,
  candidate: Candidate,
  verdict: Verdict,
): Promise<Shown> {
  const mode = disposition(verdict, gate.revisions, config.maxRevisions);
  debug.record("review.complete", {
    epoch: candidate.epoch,
    reviewToken: candidate.token,
    verdict,
    mode,
    revisions: gate.revisions,
  });
  log.record($.clock.now(), `審査 #${candidate.token}: ${verdict.decision}`, verdict.findings);
  gate.active = undefined;
  if (mode === "revise") {
    gate.revisions++;
    const delivery: Delivery = {
      token: candidate.token,
      epoch: candidate.epoch,
      context: correction(candidate.text, verdict.findings),
      mode: "revise",
      findings: verdict.findings,
    };
    gate.delivery = delivery;
    gate.phase = "correction queued";
    log.record($.clock.now(), `修正を依頼しました（${gate.revisions} 回目）。`);
    showNote($, revising(gate.revisions));
    await saveRecovery($, gate);
    queueContinuation($, delivery);
    return hidden;
  }
  switch (mode) {
    case "publish":
      gate.phase = "published";
      log.record($.clock.now(), "検証済みの本文を公開しました。");
      await saveRecovery($, gate);
      return { text: candidate.text, note: PASSED };
    case "notice":
      gate.phase = "unverified";
      if (verdict.decision === "REVISE")
        log.record($.clock.now(), "修正回数の上限に到達しました。");
      log.record($.clock.now(), "未検証の本文を注記付きで表示しました。");
      await saveRecovery($, gate);
      return {
        text: candidate.text,
        note: verdict.decision === "REVISE" ? UNRESOLVED : UNVERIFIED,
      };
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
): Promise<Shown> {
  const epoch = gate.epoch;
  const logger = debug;
  const candidate: Candidate = {
    token: ++gate.serial,
    turnId: e.turnId,
    stepIndex: e.index,
    epoch: gate.epoch,
    text,
    context: "",
    controller: new AbortController(),
    timedOut: false,
  };
  if (signal.aborted || epoch !== gate.epoch) return hidden;
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
  let directory: string | undefined;
  const materialOperationId = debug.operation();
  try {
    await saveRecovery($, gate, signal);
    logger.record("material.start", {
      operationId: materialOperationId,
      epoch,
      reviewToken: candidate.token,
    });
    if (epoch === gate.epoch) await flushDebug($, logger, false, signal);
    const generated = await $.process.run(
      ["node", `${$.plugin.root}/hooks/session-log.mts`, "create"],
      {
        stdin: JSON.stringify({
          sessionId: await $.session.id(),
          request: gate.marker,
          debug: { ...debug.identity(), reviewId: `${epoch}-${candidate.token}` },
        }),
        timeoutMs: 15_000,
      },
    );
    logger.record("material.complete", { operationId: materialOperationId, result: generated });
    if (epoch === gate.epoch) await flushDebug($, logger, false, signal);
    if (generated.exitCode !== 0 || generated.isStdoutTruncated) {
      if (!current(gate, candidate) || signal.aborted) return hidden;
      logger.record("review.unverified", {
        reason: "material_failed",
        epoch,
        reviewToken: candidate.token,
      });
      return await finishReview($, candidate, unverified());
    }
    const material = JSON.parse(generated.stdout);
    if (material.debug?.state === "failed") debugFailure($, material.debug);
    directory = material.directory;
    candidate.context = generated.stdout;
    if (!current(gate, candidate) || signal.aborted) return hidden;
    gate.material = directory;
    await saveRecovery($, gate, signal);
    let verdict = await review($, config, candidate, gate.prompt, e.model, e.effort);
    if (!current(gate, candidate) || signal.aborted) return hidden;
    if (candidate.timedOut) {
      log.record($.clock.now(), `審査 #${candidate.token}: タイムアウト`);
      verdict = { decision: "UNVERIFIED", findings: [] };
    }
    return await finishReview($, candidate, verdict);
  } catch (error) {
    logger.record("review.exception", { epoch, reviewToken: candidate.token, error }, "error");
    if (!current(gate, candidate) || signal.aborted) return hidden;
    return await finishReview($, candidate, unverified());
  } finally {
    if (directory !== undefined) {
      logger.record("material.release.start", { operationId: materialOperationId, directory });
      if (epoch === gate.epoch) await flushDebug($, logger, false, signal);
      const removed = await $.process
        .run(["node", `${$.plugin.root}/hooks/session-log.mts`, "release"], {
          stdin: JSON.stringify({ directory }),
          timeoutMs: 15_000,
        })
        .catch(() => undefined);
      logger.record("material.release.complete", {
        operationId: materialOperationId,
        result: removed,
      });
      if (removed?.exitCode !== 0) log.record($.clock.now(), "検証資料の削除に失敗しました。");
    }
    if (gate.material === directory) {
      gate.material = undefined;
      if (gate.prompt && epoch === gate.epoch) await saveRecovery($, gate, signal);
    }
    logger.record("review.cleanup", {
      epoch,
      reviewToken: candidate.token,
      timedOut: candidate.timedOut,
      aborted: signal.aborted,
      stale: epoch !== gate.epoch,
    });
    if (epoch === gate.epoch) await flushDebug($, logger, false, signal);
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
  debug.record("answer.received", {
    turnId: e.turnId,
    stepIndex: e.index,
    epoch,
    response,
    chunks,
  });
  if (next.signal.aborted || epoch !== gate.epoch) {
    debug.record("answer.discarded", { turnId: e.turnId, epoch });
    return resultOf(e, "");
  }
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
    debug.record("answer.skipped", {
      reason: !enabled()
        ? "disabled"
        : response.toolUses.length || chunks.some((c) => c.kind === "tool")
          ? "tool_step"
          : "empty",
    });
    await flushDebug($, debug, false, next.signal);
    buffered.text = "";
    yield* chunks;
    return response;
  }
  let shown: Shown;
  if (
    (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") ||
    text.length > MAX_DRAFT
  ) {
    log.record(
      $.clock.now(),
      "回答の終了条件またはサイズが審査の対象外のため、未検証の本文を表示しました。",
    );
    debug.record("review.unverified", {
      reason: text.length > MAX_DRAFT ? "draft_size_limit" : "stop_reason",
      stopReason: response.stopReason,
    });
    await flushDebug($, debug, false, next.signal);
    shown = { text, note: UNVERIFIED };
  } else {
    debug.record("status.changed", { value: WAITING });
    $.ui.status(WAITING);
    shown = await verify($, e, text, next.signal);
    debug.record("status.changed", { value: null });
    await flushDebug($, debug, false, next.signal);
    $.ui.status(undefined);
  }
  if (buffered.key === stepKey(e)) buffered.text = "";
  if (next.signal.aborted || epoch !== gate.epoch || !shown.text) return resultOf(e, "");
  if (shown.note !== undefined) showNote($, shown.note);
  yield { kind: "text", index: 0, text: shown.text };
  yield { kind: "stop", stopReason: response.stopReason, usage: response.usage };
  return { ...response, answer: shown.text };
};

const stepFailure: Hook<"turn.step"> = async function* ($, e, next) {
  debug.record(
    "hook.failed",
    { hook: "turn.step", error: "error" in next ? next.error : undefined },
    "error",
  );
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
  showNote($, text.trim() ? FAILED : NO_DRAFT);
  if (!text.trim()) return resultOf(e, "");
  yield { kind: "text", index: 0, text };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return resultOf(e, text);
};

const onPrompt: Hook<"prompt.submit"> = async ($, e, next) => {
  debug.record("prompt.received", {
    prompt: e,
    epoch: gate.epoch,
    pending: gate.active !== undefined || gate.delivery !== undefined,
  });
  if (e.origin.kind === "plugin" && e.origin.name === "cerberus-gate") {
    const delivery = gate.delivery;
    if (delivery === undefined || e.text !== controlText(delivery) || delivery.epoch !== gate.epoch)
      return { drop: "Cerberus: 古い検証処理を破棄しました。" };
    gate.action = delivery;
    gate.delivery = undefined;
    await saveRecovery($, gate);
    return next({ ...e, context: [...(e.context ?? []), delivery.context] });
  }
  // Before reset(): the reviewer's own notification must not cancel the review it belongs to.
  if (staleNotification(gate, e)) return { drop: "Cerberus: 検証結果を処理済みです。" };
  if (gate.active !== undefined || gate.delivery !== undefined)
    log.record($.clock.now(), "新しい依頼により、保留中の検証処理を取り消しました。");
  reset(gate, ...requestOf(gate, e));
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
  if (e.tool === "TaskStop" && ownTask(gate, e)) return next(e);
  if (gate.active === undefined || gate.active.controller.signal.aborted)
    return { deny: "Cerberus reviewer: no active review." };
  return next(e);
};
const onCheck: Hook<"tool.check"> = async (_$, e, next) => {
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId))
    return e.tool === "SubagentHandback"
      ? next(e)
      : { decision: "deny", reason: "Cerberus: stale reviewer stopped." };
  if (next.origin.plugin !== "cerberus-gate") return next(e);
  if (e.tool === "TaskStop" && ownTask(gate, e.input)) return next(e);
  if (gate.active === undefined || gate.active.controller.signal.aborted)
    return {
      decision: "deny",
      reason: "Cerberus: no active review.",
    };
  return next(e);
};

export const register: Register = (on, options) => {
  gate.sessionEnabled = undefined;
  pendingEnabled = undefined;
  log.clear();
  configured = true;
  configError = undefined;
  try {
    config = readConfig(options);
  } catch (error) {
    configError = error;
    configured = false;
  }
  on("session.start", async ($, e, next) => {
    log.clear();
    interactive = e.isInteractive;
    configured = configured && (await $.session.version()).base === "2.1.310";
    await initializeDebug($, { event: e, options, configError });
    log.record($.clock.now(), "Cerberus Gate を起動しました。");
    if (!configured) log.record($.clock.now(), "設定または Claude Code のバージョンが対象外です。");
    if (!interactive) log.record($.clock.now(), "非対話セッションは対象外です。");
    const recovery = (await $.state.get({ plugin: "cerberus-gate", key: "recovery" })).value;
    if (recovery?.material !== undefined) {
      await $.process
        .run(["node", `${$.plugin.root}/hooks/session-log.mts`, "release"], {
          stdin: JSON.stringify({ directory: recovery.material }),
          timeoutMs: 15_000,
        })
        .catch(() => undefined);
    }
    gate.material = undefined;
    debug.record("recovery.loaded", recovery);
    const pending = restoreRecovery(gate, recovery);
    if (gate.prompt) log.record($.clock.now(), "再ロード前の依頼と修正回数を復元しました。");
    for (const agent of await $.agent.list()) {
      if (agent.type !== REVIEWER || agent.spawnedBy !== "cerberus-gate") continue;
      gate.reviewers.add(agent.id);
      if (agent.status === "running")
        await $.tool.call({ tool: "TaskStop", task_id: agent.id }).catch(() => undefined);
    }
    await $.command.register({
      name: "cerberus",
      description: "回答検証の状態・履歴・デバッグログを表示",
      argumentHint: "[on|off|reset|model|history|log|cancel]",
      immediate: true,
    });
    await $.command.register({
      name: "cgate",
      description: "Cerberus Gate の状態・セッションログを表示",
      argumentHint: "[on|off|reset|model|history|log|cancel]",
      immediate: true,
    });
    if (pending && gate.prompt && configured && interactive && enabled()) {
      const delivery: Delivery = {
        token: ++gate.serial,
        epoch: gate.epoch,
        mode: "restart",
        findings: [],
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
    debug.record("command.received", { command: e.command, argument });
    void flushDebug($, debug, true);
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
    if (argument === "history") return { text: await log.text() };
    if (argument === "log") return { text: debug.text() };
    if (argument !== "" && argument !== "cancel")
      return { text: "使い方: /cgate [on|off|reset|model|history|log|cancel]" };
    if (argument === "cancel") {
      const turnId = gate.active?.turnId;
      reset(gate, gate.prompt, gate.marker);
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
        } catch (error) {
          debug.record("settings.failed", { setting: "reviewerModel", error }, "error");
          await flushDebug($);
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
        } catch (error) {
          debug.record("settings.failed", { setting: "reviewerEffort", error }, "error");
          await flushDebug($);
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
  on("tool.call", onTool).catch(async ($, e, next) => {
    debug.record("hook.failed", { hook: "tool.call", input: e, error: next.error }, "error");
    await flushDebug($);
    return { deny: "Cerberus: reviewer tool guard failed." };
  });
  on("tool.check", onCheck).catch(async ($, e, next) => {
    debug.record("hook.failed", { hook: "tool.check", input: e, error: next.error }, "error");
    await flushDebug($);
    return { decision: "deny", reason: "Cerberus: permission guard failed." };
  });
  on("turn.abort", async ($, e, next) => {
    log.record($.clock.now(), "回答処理が中断されました。");
    reset(gate, gate.prompt, gate.marker);
    gate.phase = "cancelled";
    await saveRecovery($, gate);
    $.ui.status(undefined);
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    debug.record("session.end", e);
    await flushDebug($, debug, true);
    log.clear();
    reset(gate, "");
    gate.tasks.clear();
    gate.sessionEnabled = undefined;
    pendingEnabled = undefined;
    await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, null);
    return next(e);
  });
};
