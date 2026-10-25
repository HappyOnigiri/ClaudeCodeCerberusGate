import type { Verdict } from "./policy.ts";
export type Candidate = {
  token: number;
  turnId: string;
  epoch: number;
  text: string;
  context: string;
  controller: AbortController;
  timedOut: boolean;
};
export type Delivery = {
  token: number;
  epoch: number;
  context: string;
  mode: "revise" | "restart";
};
type Phase =
  | "idle"
  | "reviewing"
  | "correction queued"
  | "publish"
  | "notice"
  | "published"
  | "unverified"
  | "cancelled";

export function createState() {
  return {
    epoch: 0,
    serial: 0,
    revisions: 0,
    active: undefined as Candidate | undefined,
    delivery: undefined as Delivery | undefined,
    action: undefined as Delivery | undefined,
    reviewers: new Set<string>(),
    prompt: "",
    phase: "idle" as Phase,
    blocked: false,
  };
}
export type GateState = ReturnType<typeof createState>;
export function reset(state: GateState, prompt: string): void {
  state.active?.controller.abort();
  state.epoch++;
  state.revisions = 0;
  state.active = undefined;
  state.delivery = undefined;
  state.action = undefined;
  state.prompt = prompt;
  state.phase = "idle";
  state.blocked = false;
}
export function current(state: GateState, candidate: Candidate): boolean {
  return state.active === candidate && candidate.epoch === state.epoch && !state.blocked;
}
export type Mode = "publish" | "revise" | "notice";

export function disposition(verdict: Verdict, revisions: number, max: number): Mode {
  const modes = {
    PASS: "publish",
    REVISE: revisions < max ? "revise" : "notice",
    UNVERIFIED: "notice",
  } satisfies Record<Verdict["decision"], Mode>;
  return modes[verdict.decision];
}
