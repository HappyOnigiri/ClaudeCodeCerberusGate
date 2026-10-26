import { CONTROL, formatFindings } from "./policy.ts";
import type { Verdict } from "./policy.ts";
export type Candidate = {
  token: number;
  turnId: string;
  stepIndex: number;
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
  findings: readonly string[];
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
    sessionEnabled: undefined as boolean | undefined,
    epoch: 0,
    serial: 0,
    revisions: 0,
    active: undefined as Candidate | undefined,
    material: undefined as string | undefined,
    delivery: undefined as Delivery | undefined,
    action: undefined as Delivery | undefined,
    reviewers: new Set<string>(),
    // Background commands of reviewer tool calls. Kept across requests and reloads because their
    // notifications arrive after the review; never cleared by reset().
    tasks: new Set<string>(),
    prompt: "",
    // Text that proves the request reached the transcript; slash commands are stored in tag form.
    marker: "",
    phase: "idle" as Phase,
    blocked: false,
  };
}
export type GateState = ReturnType<typeof createState>;
export function reset(state: GateState, prompt: string, marker = prompt): void {
  state.active?.controller.abort();
  state.epoch++;
  state.revisions = 0;
  state.active = undefined;
  state.delivery = undefined;
  state.action = undefined;
  state.prompt = prompt;
  state.marker = marker;
  state.phase = "idle";
  state.blocked = false;
}
export function transcriptMarker(e: { text: string; command?: { name: string; args: string } }) {
  if (e.command === undefined) return e.text;
  const name = `<command-name>/${e.command.name}</command-name>`;
  // The transcript omits the args tag when nothing follows the command.
  return e.command.args ? `${name}\n<command-args>${e.command.args}</command-args>` : name;
}
// A background task's notification is not a request: the review keeps the user's request it
// continues. Mid-turn notifications leave no user record, so their text cannot be matched.
export function requestOf(
  state: GateState,
  e: Parameters<typeof transcriptMarker>[0] & { origin: { kind: string } },
): [prompt: string, marker: string] {
  if (e.origin.kind === "task-notification" && state.prompt) return [state.prompt, state.marker];
  return [e.text, transcriptMarker(e)];
}
// A notification during a review or correction joins that cycle: resetting would void the queued
// correction, and the engine skips the model call of a queue batch led by a dropped prompt.
export function joinsCycle(state: GateState, e: { origin: { kind: string } }): boolean {
  return (
    e.origin.kind === "task-notification" &&
    state.prompt !== "" &&
    (state.active !== undefined || state.delivery !== undefined || state.action !== undefined)
  );
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

export function resultOf(e: { turnId: string; index: number }, answer: string) {
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses: [],
    stopReason: "end_turn" as const,
    usage: null,
  };
}
// The answer the model will read later carries no gate notice, so the notice is logged beside it.
export type Shown = { text: string; note?: string };
export const hidden: Shown = { text: "" };
export const controlText = (delivery: Delivery): string =>
  `${CONTROL} [${delivery.epoch}-${delivery.token}]${delivery.findings.length ? `\n\n${formatFindings(delivery.findings)}` : ""}`;

const MAX_TASKS = 32;
export function rememberTask(state: GateState, id: string): void {
  state.tasks.delete(id);
  state.tasks.add(id);
  for (const old of state.tasks) {
    if (state.tasks.size <= MAX_TASKS) break;
    state.tasks.delete(old);
  }
}
// TaskStop is the Mod's own cleanup only for its reviewers and their background commands.
export function ownTask(state: GateState, input: unknown): boolean {
  if (typeof input !== "object" || input === null || !("task_id" in input)) return false;
  const id = input.task_id;
  return typeof id === "string" && (state.reviewers.has(id) || state.tasks.has(id));
}
const TASK_ID = /<task-id>([^<]*)<\/task-id>/u;
// Late notifications of reviewers left by an older plugin, or of a reviewer's background command.
export function staleNotification(
  state: GateState,
  e: { text: string; origin: { kind: string } },
): boolean {
  const kind = e.origin.kind;
  if (kind !== "task-notification" && kind !== "peer" && kind !== "peer-send-message") return false;
  const task = kind === "task-notification" ? TASK_ID.exec(e.text)?.[1] : undefined;
  if (task !== undefined && state.tasks.has(task)) return true;
  return [...state.reviewers].some((id) => e.text.includes(id));
}
