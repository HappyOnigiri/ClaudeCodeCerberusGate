import type { GateState } from "./state.ts";

// 原稿・指摘は保持せず、同じセッションで作業を続けるための状態だけを残す。
export function snapshotRecovery(gate: GateState) {
  return {
    sessionEnabled: gate.sessionEnabled,
    material: gate.material,
    prompt: gate.prompt,
    epoch: gate.epoch,
    serial: gate.serial,
    revisions: gate.revisions,
    pending: gate.active !== undefined || gate.delivery !== undefined || gate.action !== undefined,
  };
}

export function restoreRecovery(
  gate: GateState,
  value:
    | (Omit<ReturnType<typeof snapshotRecovery>, "sessionEnabled" | "material"> & {
        sessionEnabled?: boolean;
        material?: string;
      })
    | null
    | undefined,
): boolean {
  if (value === undefined || value === null) return false;
  gate.sessionEnabled = value.sessionEnabled;
  gate.prompt = value.prompt;
  gate.epoch = value.epoch + 1;
  gate.serial = value.serial;
  gate.revisions = value.revisions;
  return value.pending;
}
