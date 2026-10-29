import { phases, settingFor, menuItems } from "./menu.ts";
import { translate } from "./locale.ts";
import { RESTART_JA } from "./prompts-ja.ts";
import { correction, MAX_DRAFT, readConfig, REVIEWER, supportedVersion } from "./policy.ts";
import { restoreRecovery, snapshotRecovery } from "./recovery.ts";
import {
  controlText,
  createState,
  current,
  disposition,
  finishMainTask,
  hidden,
  joinsCycle,
  ownTask,
  rememberTask,
  requestOf,
  reset,
  resultOf,
  runningAgents,
  staleNotification,
  trackMainAgent,
  trackMainTask,
} from "./state.ts";
import { backgroundTask } from "./review.ts";
import { review, unverified } from "./review-loop.ts";
import { createDebug } from "./debug.ts";
import { createLog } from "./log.ts";
import type { Candidate, Delivery, GateState, Shown } from "./state.ts";
import type { Config, Verdict } from "./policy.ts";
import type {
  EngineInterface,
  Hook,
  Register,
  TurnStepInput,
  RenderInput,
  SelectProps,
} from "claude-code";

const gate = createState();
const t = (key: Parameters<typeof translate>[1], ...values: (string | number)[]) =>
  translate(config.language, key, ...values);
const log = createLog(() => config.language);
let debug = createDebug(() => config.language);
let debugQueue: Promise<void> = Promise.resolve();
function debugFailure($: EngineInterface, error: unknown): void {
  debug.failed(error);
  try {
    log.record($.clock.now(), t("debugSaveFailure"));
    $.ui.toast(t("debugSaveToast"), { timeoutMs: 3000 });
  } catch {
    /* Diagnostic notifications must not interrupt publication. */
  }
}
async function goBack($: EngineInterface, id: string) {
  if (id === "enabled-scope") pendingEnabled = undefined;
  await $.ui.close({ id });
  if (id !== "menu")
    await openPane(
      $,
      id === "reviewer-effort" ? "reviewer-model" : "menu",
      t(id === "reviewer-effort" ? "modelPane" : "menuPane"),
    );
}
function picker($: EngineInterface, e: RenderInput, props: SelectProps) {
  if (e.surface === "mobile") return $.ui.resolve(e).Text({ children: props.label ?? "" });
  const { Box, Button, Select, Text } = $.ui.resolve(e);
  return Box({
    flexDirection: "column",
    children: [
      Button({
        key: "back",
        label: t("backHint"),
        onPress: () => goBack($, e.requestId ?? "menu"),
      }),
      ...(e.requestId === "menu"
        ? [
            Text({ children: props.label }),
            ...props.options.map((option, index) =>
              Button({
                key: `menu-${option.value}`,
                label: option.label ?? option.value,
                hotkey: String(index + 1),
                plain: true,
                autoFocus: option.value === props.value ? true : undefined,
                onPress: () =>
                  props.onSelect(option.value, {
                    plugin: "cerberus-gate",
                    component: "Pane",
                    requestId: e.requestId,
                    surface: e.surface,
                    element: props.key,
                    value: option.value,
                  }),
              }),
            ),
          ]
        : [Select(props)]),
    ],
  });
}
async function openPane($: EngineInterface, id: string, title: string): Promise<void> {
  await $.ui.open({ id, title, focus: true, closeOnEscape: true });
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
  debug = createDebug(() => config.language);
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
let historyText = "";
let detailsText = "";
let menuValue = "status";
const enabled = (): boolean => gate.sessionEnabled ?? config.enabled;
const status = (): string =>
  t(
    "status",
    enabled() ? t("enabledWord") : t("disabledWord"),
    t(gate.sessionEnabled === undefined ? "savedSource" : "sessionSource"),
    t(phases[gate.phase]),
    gate.revisions,
  );
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
        return { ok: false, text: t("enabledSaveFailure") };
      config = { ...config, enabled: result.value };
      gate.sessionEnabled = undefined;
    } catch (error) {
      debug.record("settings.failed", { setting: "enabled", error }, "error");
      await flushDebug($);
      return { ok: false, text: t("enabledSaveFailure") };
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
    text: status() + (!enabled() && pending ? t("pendingCancelled") : ""),
  };
}

// Submission is deferred so it cannot wait on the turn holding the unpublished answer.
function queueContinuation($: EngineInterface, delivery: Delivery): void {
  $.clock.after(0, async () => {
    if (gate.delivery !== delivery || gate.epoch !== delivery.epoch) return;
    const operationId = debug.operation();
    debug.record("delivery.start", { operationId, ...delivery });
    await flushDebug($);
    if (gate.delivery !== delivery || gate.epoch !== delivery.epoch) return;
    // A reload's session.start dispatch may not include prompt.submit hooks yet.
    // Carry restart context and its accepted state in the submission itself.
    let sent;
    try {
      if (delivery.mode === "restart") {
        gate.action = delivery;
        gate.delivery = undefined;
        await saveRecovery($, gate);
        if (gate.action !== delivery || gate.epoch !== delivery.epoch) return;
      }
      sent = await $.prompt.submit({
        text: controlText(delivery, config.language),
        ...(delivery.mode === "restart" ? { context: [delivery.context] } : {}),
      });
    } catch (error) {
      debug.record("delivery.failed", { operationId, error }, "error");
    }
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
    if (delivery.mode === "restart") {
      log.record($.clock.now(), t("resumeFailure"));
    } else {
      log.record($.clock.now(), t("deliveryFailure"));
      $.ui.toast(t("deliveryToast"), {
        timeoutMs: 3000,
      });
    }
    await saveRecovery($, gate).catch((error: unknown) => {
      debug.record("delivery.recovery.failed", { operationId, error }, "error");
    });
  });
}
// Regular reviews queue only REVISE; reload recovery can also request a fresh answer.
async function finishReview(
  $: EngineInterface,
  candidate: Candidate,
  verdict: Verdict,
): Promise<Shown> {
  const mode = disposition(verdict);
  debug.record("review.complete", {
    epoch: candidate.epoch,
    reviewToken: candidate.token,
    verdict,
    mode,
    revisions: gate.revisions,
  });
  log.record($.clock.now(), t("reviewResult", candidate.token, verdict.decision), verdict.findings);
  gate.active = undefined;
  if (mode === "revise") {
    gate.revisions++;
    const delivery: Delivery = {
      token: candidate.token,
      epoch: candidate.epoch,
      context: correction(candidate.text, verdict.findings, config.language),
      mode: "revise",
      findings: verdict.findings,
    };
    gate.delivery = delivery;
    gate.phase = "correction queued";
    log.record($.clock.now(), t("correctionRequested", gate.revisions));
    showNote($, t("revising", gate.revisions));
    await saveRecovery($, gate);
    queueContinuation($, delivery);
    return hidden;
  }
  switch (mode) {
    case "publish":
      gate.phase = "published";
      log.record($.clock.now(), t("published"));
      await saveRecovery($, gate);
      return { text: candidate.text, note: t("passed") };
    case "notice":
      gate.phase = "unverified";
      log.record($.clock.now(), t("unverifiedPublished"));
      await saveRecovery($, gate);
      return {
        text: candidate.text,
        note: t("unverified"),
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
  log.record($.clock.now(), t("reviewStarted", candidate.token));
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
    const reviewLogger = debug;
    let verdict = await review($, config, candidate, gate.prompt, e.model, e.effort, {
      logger: reviewLogger,
      flush: (s) => flushDebug($, reviewLogger, false, s),
      rememberTask: (id) => rememberTask(gate, id),
      saveTasks: () => saveRecovery($, gate),
    });
    if (!current(gate, candidate) || signal.aborted) return hidden;
    if (candidate.timedOut) {
      log.record($.clock.now(), t("reviewTimeout", candidate.token));
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
      if (removed?.exitCode !== 0) log.record($.clock.now(), t("releaseFailure"));
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

// A short answer while the main loop's background work runs is an interim report: the answer
// written after that work ends is reviewed.
async function interimWork(
  $: EngineInterface,
  text: string,
): Promise<{ agents: number; shells: number } | undefined> {
  if (text.length > config.interimMaxChars) return undefined;
  try {
    const agents = runningAgents(gate, await $.agent.list());
    const shells = gate.mainTasks.size;
    return agents + shells > 0 ? { agents, shells } : undefined;
  } catch (error) {
    debug.record("interim.failed", { error }, "error");
    return undefined;
  }
}
async function skipInterim(
  $: EngineInterface,
  text: string,
  work: { agents: number; shells: number },
  action: Delivery | undefined,
  signal: AbortSignal,
): Promise<Shown> {
  log.record($.clock.now(), t("interimPublished"));
  debug.record("review.skipped", { ...work, length: text.length, correction: action?.token });
  // A correction's turn that waits for its work keeps the cycle, so notifications join it and
  // the correction count is not reset.
  if (action !== undefined) {
    gate.action = action;
    await saveRecovery($, gate, signal);
  } else await flushDebug($, debug, false, signal);
  return { text, note: t("skipped", work.agents, work.shells, text.length) };
}

const onStep: Hook<"turn.step"> = async function* ($, e, next) {
  if (e.agentId !== undefined) return yield* next(e);
  const epoch = gate.epoch;
  const action = gate.action;
  if (gate.action !== undefined) {
    gate.action = undefined;
    await saveRecovery($, gate);
  }
  if (!enabled()) return yield* next(e);
  // Non-interactive sessions (`-p`, the SDK, Desktop routines) are out of scope and pass through.
  if (!interactive || !configured || gate.blocked || !gate.prompt) return yield* next(e);
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
  if (gate.delivery !== undefined) {
    // A queued correction supersedes this answer (a notification's turn); its own turn is reviewed.
    debug.record("answer.superseded", { turnId: e.turnId, epoch, token: gate.delivery.token });
    log.record($.clock.now(), t("answerPending"));
    shown = hidden;
  } else if (
    (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") ||
    text.length > MAX_DRAFT
  ) {
    log.record($.clock.now(), t("outsideLimits"));
    debug.record("review.unverified", {
      reason: text.length > MAX_DRAFT ? "draft_size_limit" : "stop_reason",
      stopReason: response.stopReason,
    });
    await flushDebug($, debug, false, next.signal);
    shown = { text, note: t("unverified") };
  } else {
    const work = await interimWork($, text);
    if (work !== undefined) shown = await skipInterim($, text, work, action, next.signal);
    else if (gate.revisions >= config.maxRevisions) {
      gate.phase = "unverified";
      log.record($.clock.now(), t("limitPublished"));
      debug.record("review.skipped", { reason: "revision_limit", revisions: gate.revisions });
      await saveRecovery($, gate, next.signal);
      shown = { text, note: t("revisionLimit") };
    } else {
      debug.record("status.changed", { value: t("waiting") });
      $.ui.status(t("waiting"));
      shown = await verify($, e, text, next.signal);
      debug.record("status.changed", { value: null });
      await flushDebug($, debug, false, next.signal);
      $.ui.status(undefined);
    }
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
  log.record($.clock.now(), text.trim() ? t("answerError") : t("emptyError"));
  gate.active?.controller.abort();
  gate.blocked = true;
  gate.active = undefined;
  gate.delivery = undefined;
  gate.action = undefined;
  await saveRecovery($, gate);
  $.ui.status(undefined);
  showNote($, text.trim() ? t("failed") : t("noDraft"));
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
    joins: joinsCycle(gate, e),
  });
  if (e.origin.kind === "plugin" && e.origin.name === "cerberus-gate") {
    const delivery =
      gate.delivery ??
      (gate.action?.mode === "restart" && e.context?.includes(gate.action.context)
        ? gate.action
        : undefined);
    if (
      delivery === undefined ||
      e.text !== controlText(delivery, config.language) ||
      delivery.epoch !== gate.epoch
    )
      return { drop: t("staleContinuation") };
    gate.action = delivery;
    gate.delivery = undefined;
    await saveRecovery($, gate);
    const context = e.context ?? [];
    return next({
      ...e,
      context: context.includes(delivery.context) ? context : [...context, delivery.context],
    });
  }
  // Before reset(): the reviewer's own notification must not cancel the review it belongs to.
  if (staleNotification(gate, e)) return { drop: t("handledResult") };
  if (e.origin.kind === "task-notification") finishMainTask(gate, e);
  else {
    gate.mainTasks.clear();
    gate.mainAgents.clear();
  }
  if (joinsCycle(gate, e)) return next(e);
  if (gate.active !== undefined || gate.delivery !== undefined)
    log.record($.clock.now(), t("newRequest"));
  reset(gate, ...requestOf(gate, e));
  await saveRecovery($, gate);
  $.ui.status(undefined);
  return next(e);
};

const onTool: Hook<"tool.call"> = async (_$, e, next) => {
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId)) {
    if (e.tool === "SubagentHandback") return next({ ...e, message: t("reviewerCompleted") });
    return { deny: t("staleReviewer") };
  }
  if (next.origin.plugin !== "cerberus-gate") {
    const result = await next(e);
    if (e.agentId === undefined) {
      trackMainTask(gate, e, backgroundTask(result));
      trackMainAgent(gate, result);
    }
    return result;
  }
  if (e.tool === "TaskStop" && ownTask(gate, e)) return next(e);
  if (gate.active === undefined || gate.active.controller.signal.aborted)
    return { deny: t("noActiveReviewer") };
  return next(e);
};
const onCheck: Hook<"tool.check"> = async (_$, e, next) => {
  if (e.agentId !== undefined && gate.reviewers.has(e.agentId))
    return e.tool === "SubagentHandback"
      ? next(e)
      : { decision: "deny", reason: t("staleReviewer") };
  if (next.origin.plugin !== "cerberus-gate") return next(e);
  if (e.tool === "TaskStop" && ownTask(gate, e.input)) return next(e);
  if (gate.active === undefined || gate.active.controller.signal.aborted)
    return {
      decision: "deny",
      reason: t("noActiveReview"),
    };
  return next(e);
};

async function runCommand($: EngineInterface, argument: string) {
  debug.record("command.received", { argument });
  void flushDebug($, debug, true);
  if (argument === "") {
    await openPane($, "menu", t("menuPane"));
    return { text: status() };
  }
  if (argument === "on" || argument === "off") {
    pendingEnabled = argument === "on";
    await openPane($, "enabled-scope", t("enabledScope"));
    return {};
  }
  if (argument === "reset") {
    pendingEnabled = undefined;
    return { text: (await applyEnabled($, undefined, false)).text };
  }
  if (argument === "language") {
    await openPane($, "language", t("languageLabel"));
    return {};
  }
  if (argument === "model") {
    await openPane($, "reviewer-model", t("modelPane"));
    return {};
  }
  if (argument === "history") {
    historyText = await log.text();
    await openPane($, "history", t("historyPane"));
    return {};
  }
  if (argument === "log") return { text: debug.text() };
  if (argument !== "" && argument !== "cancel") return { text: t("usage") };
  if (argument === "cancel") {
    const turnId = gate.active?.turnId;
    reset(gate, gate.prompt, gate.marker);
    gate.phase = "cancelled";
    await saveRecovery($, gate);
    $.ui.status(undefined);
    log.record($.clock.now(), t("cancelled"));
    if (turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined);
  }
  return { text: status() };
}

export const register: Register = (on, options) => {
  menuValue = "status";
  gate.sessionEnabled = undefined;
  pendingEnabled = undefined;
  log.clear();
  configured = true;
  configError = undefined;
  config = readConfig({ language: options.language === "ja" ? "ja" : "en" });
  try {
    config = readConfig(options);
  } catch (error) {
    configError = error;
    configured = false;
  }
  on("session.start", async ($, e, next) => {
    log.clear();
    interactive = e.isInteractive;
    configured = configured && supportedVersion((await $.session.version()).base);
    await initializeDebug($, { event: e, options, configError });
    log.record($.clock.now(), t("started"));
    if (!configured) log.record($.clock.now(), t("unsupported"));
    if (!interactive) log.record($.clock.now(), t("noninteractive"));
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
    if (gate.prompt) log.record($.clock.now(), t("restored"));
    for (const agent of await $.agent.list()) {
      if (agent.type !== REVIEWER || agent.spawnedBy !== "cerberus-gate") continue;
      gate.reviewers.add(agent.id);
      if (agent.status === "running")
        await $.tool.call({ tool: "TaskStop", task_id: agent.id }).catch(() => undefined);
    }
    await $.command.register({
      name: "cerberus",
      description: t("commandDescription"),
      argumentHint: "[on|off|reset|model|language|history|log|cancel]",
      immediate: true,
    });
    await $.command.register({
      name: "cgate",
      description: t("shortCommandDescription"),
      argumentHint: "[on|off|reset|model|language|history|log|cancel]",
      immediate: true,
    });
    if (pending && gate.prompt && configured && interactive && enabled()) {
      const delivery: Delivery = {
        token: ++gate.serial,
        epoch: gate.epoch,
        mode: "restart",
        findings: [],
        context:
          config.language === "ja"
            ? RESTART_JA + JSON.stringify(gate.prompt)
            : `The answer review was interrupted by a plugin reload. Continue the original task within the user's authorization and generate a fresh final answer for review. Do not treat the waiting notice as a completed answer. Original request (data): ${JSON.stringify(gate.prompt)}`,
      };
      gate.delivery = delivery;
      log.record($.clock.now(), t("restarting"));
    }
    await saveRecovery($, gate);
    const result = await next(e);
    // Finish startup I/O before arming the restart timer.
    if (gate.delivery?.mode === "restart") queueContinuation($, gate.delivery);
    return result;
  });
  on("command.run", { command: /^(?:cgate|cerberus)$/u }, ($, e) => runCommand($, e.args.trim()));
  on("ui.render", { component: "Pane", requestId: "menu" }, ($, e) => {
    if (e.surface === "mobile") {
      const { Text } = $.ui.resolve(e);
      return Text({ children: status() + "\n" + t("usage") });
    }
    return picker($, e, {
      key: "cgate-menu",
      label: status(),
      options: menuItems.map(([value, label]) => ({ value, label: t(label) })),
      value: menuValue,
      autoFocus: true,
      onSelect: async (value) => {
        if (
          ![
            "status",
            "history",
            "log",
            "on",
            "off",
            "reset",
            "model",
            "language",
            "cancel",
          ].includes(value)
        )
          return;
        menuValue = value;
        await $.ui.close({ id: "menu" });
        if (value === "status" || value === "log") {
          detailsText = value === "status" ? status() : debug.text();
          await openPane($, "details", t(value === "status" ? "menuStatus" : "menuLog"));
        } else if (
          ["history", "on", "off", "reset", "model", "language", "cancel"].includes(value)
        ) {
          const result = await runCommand($, value);
          if (result.text) $.ui.toast(result.text, { timeoutMs: 3000 });
        }
      },
    });
  });
  on("ui.render", { component: "Pane", requestId: /^(?:details|history)$/u }, ($, e) => {
    const text = e.requestId === "history" ? historyText : detailsText;
    if (e.surface === "mobile") return $.ui.resolve(e).Text({ children: text });
    const { Box, Text, Button } = $.ui.resolve(e);
    return Box({
      flexDirection: "column",
      children: [
        Button({
          key: "back",
          label: t("backHint"),
          autoFocus: true,
          onPress: () => goBack($, e.requestId),
        }),
        Text({ children: text }),
      ],
    });
  });
  on("ui.render", { component: "Pane", requestId: "enabled-scope" }, ($, e) => {
    const desired = pendingEnabled;
    if (e.surface === "mobile" || desired === undefined) {
      const { Text } = $.ui.resolve(e);
      return Text({
        children: t("mobileScope"),
      });
    }
    return picker($, e, {
      key: `enabled-scope-${desired}`,
      label: t("scopeLabel", desired ? t("enabledWord") : t("disabledWord")),
      options: [
        { value: "session", label: t("sessionScope") },
        { value: "saved", label: t("savedScope") },
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
  on(
    "ui.render",
    { component: "Pane", requestId: /^(?:reviewer-model|reviewer-effort|language)$/u },
    ($, e) => {
      const setting = settingFor(e.requestId, config);
      if (e.surface === "mobile") return $.ui.resolve(e).Text({ children: t(setting.mobile) });
      return picker($, e, {
        key: e.requestId,
        label: t(setting.label, config.reviewerModel),
        options: setting.values.map((value) => ({
          value,
          label: setting.key === "language" ? (value === "ja" ? "日本語" : "English") : value,
        })),
        value: setting.value,
        autoFocus: true,
        onSelect: async (value) => {
          if (!setting.values.includes(value)) return;
          try {
            const result =
              setting.key === "reviewerModel"
                ? await $.config.set({ key: "cerberus-gate.reviewerModel", value })
                : setting.key === "reviewerEffort"
                  ? await $.config.set({ key: "cerberus-gate.reviewerEffort", value })
                  : await $.config.set({ key: "cerberus-gate.language", value });
            if (result.deny !== undefined) {
              $.ui.toast(t(setting.denied, result.deny), { timeoutMs: 3000 });
              return;
            }
            config = readConfig({
              ...options,
              language: config.language,
              enabled: config.enabled,
              reviewerModel: config.reviewerModel,
              reviewerEffort: config.reviewerEffort,
              [setting.key]: result.value,
            });
            $.ui.toast(t(setting.saved, String(result.value)), { timeoutMs: 3000 });
            await $.ui.close({ id: e.requestId });
            if (setting.key === "reviewerModel")
              await openPane($, "reviewer-effort", t("effortPane"));
            if (setting.key === "language") await openPane($, "menu", t("menuPane"));
          } catch (error) {
            debug.record("settings.failed", { setting, error }, "error");
            await flushDebug($);
            $.ui.toast(t(setting.failure), { timeoutMs: 3000 });
          }
        },
      });
    },
  );
  on("agent.offer", { agent: REVIEWER }, () => ({ isOffered: false })).catch(() => ({
    isOffered: false,
  }));
  on("agent.spawn", { subagentType: REVIEWER }, () => ({ deny: t("inlineReviews") }));
  on("turn.step", onStep).catch(stepFailure);
  on("prompt.submit", onPrompt);
  on("tool.call", onTool).catch(async ($, e, next) => {
    debug.record("hook.failed", { hook: "tool.call", input: e, error: next.error }, "error");
    await flushDebug($);
    return { deny: t("guardFailed") };
  });
  on("tool.check", onCheck).catch(async ($, e, next) => {
    debug.record("hook.failed", { hook: "tool.check", input: e, error: next.error }, "error");
    await flushDebug($);
    return { decision: "deny", reason: t("permissionFailed") };
  });
  on("turn.abort", async ($, e, next) => {
    log.record($.clock.now(), t("interrupted"));
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
    gate.mainTasks.clear();
    gate.mainAgents.clear();
    gate.sessionEnabled = undefined;
    pendingEnabled = undefined;
    await $.state.set({ plugin: "cerberus-gate", key: "recovery" }, null);
    return next(e);
  });
};
