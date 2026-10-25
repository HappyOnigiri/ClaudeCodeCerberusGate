import type { EngineInterface } from "claude-code";
import type { GateState } from "./state.ts";

const reference = { plugin: "cerberus-gate", key: "recovery" } as const;

// 原稿・指摘は保持せず、同じセッションで作業を続けるための状態だけを残す。
export async function saveRecovery($: EngineInterface, gate: GateState): Promise<void> {
  await $.state.set(reference, {
    prompt: gate.prompt,
    epoch: gate.epoch,
    serial: gate.serial,
    revisions: gate.revisions,
    pending: gate.active !== undefined || gate.delivery !== undefined || gate.action !== undefined,
  });
}

export async function restoreRecovery($: EngineInterface, gate: GateState): Promise<boolean> {
  const { value } = await $.state.get(reference);
  if (value === undefined || value === null) return false;
  gate.prompt = value.prompt;
  gate.epoch = value.epoch + 1;
  gate.serial = value.serial;
  gate.revisions = value.revisions;
  return value.pending;
}

export async function clearRecovery($: EngineInterface): Promise<void> {
  await $.state.set(reference, null);
}
