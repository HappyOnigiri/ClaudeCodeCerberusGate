import { MAX_DRAFT, diagnoseVerdict } from "./policy.ts";
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
import type { createDebug } from "./debug.ts";
import type { Candidate } from "./state.ts";
import type { Config, Verdict } from "./policy.ts";
import type { EngineInterface, TurnStepInput, ToolCallArgs, ToolCallResult } from "claude-code";

// Debug sink of the caller; flush writes the logger's pending records for this review.
// rememberTask and saveTasks keep the reviewer's background tasks in the caller's state.
export interface ReviewIo {
  logger: ReturnType<typeof createDebug>;
  flush: (signal: AbortSignal) => Promise<void>;
  rememberTask: (id: string) => void;
  saveTasks: () => Promise<void>;
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
async function stopReviewerTask(
  $: EngineInterface,
  { logger, rememberTask, saveTasks }: ReviewIo,
  id: string,
) {
  rememberTask(id);
  const operationId = logger.operation();
  logger.record("task.stop.start", { operationId, taskId: id });
  const result = await $.tool
    .call({ tool: "TaskStop", task_id: id })
    .catch((error: unknown) => ({ error }));
  logger.record("task.stop.complete", { operationId, taskId: id, result });
  await saveTasks().catch(() => undefined);
}

export const unverified = (): Verdict => ({ decision: "UNVERIFIED", findings: [] });

export async function review(
  $: EngineInterface,
  reviewConfig: Config,
  candidate: Candidate,
  request: string,
  model: string,
  effort: TurnStepInput["effort"],
  io: ReviewIo,
): Promise<Verdict> {
  const { logger, flush } = io;
  const signal = candidate.controller.signal;
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
      await flush(signal);
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
      await flush(signal);
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
      await flush(signal);
      const result = await cancellable(
        callReviewTool($, call, names).then(async (value) => {
          logger.record(signal.aborted ? "tool.discarded" : "tool.complete", {
            ...correlation,
            operationId: toolOperationId,
            result: value,
          });
          const task = backgroundTask(value);
          if (task !== undefined) await stopReviewerTask($, io, task.id);
          return value;
        }),
        signal,
      );
      await flush(signal);
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
