import type { Verdict } from "./policy.ts";
export type Candidate = {
  token: number;
  epoch: number;
  text: string;
  context: string;
  agentId?: string;
  rawReview: string;
};
export type Delivery = {
  token: number;
  epoch: number;
  mode: "publish" | "revise" | "notice";
  text: string;
  context?: string;
};
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
    phase: "idle",
    blocked: false,
  };
}
export type GateState = ReturnType<typeof createState>;
export function reset(state: GateState, prompt: string): void {
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
export function disposition(
  verdict: Verdict,
  revisions: number,
  max: number,
): "publish" | "revise" | "notice" {
  if (verdict.decision === "PASS") return "publish";
  return verdict.decision === "REVISE" && revisions < max ? "revise" : "notice";
}
