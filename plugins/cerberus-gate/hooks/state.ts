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
    // Background commands the main loop started in the current request. A short answer while
    // they run is an interim report; cleared by a new request, not by reset().
    mainTasks: new Set<string>(),
    // Background subagents the main loop started in the current request. One that has ended still
    // counts until its notification reaches the main loop, which then answers in another turn.
    mainAgents: new Set<string>(),
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
function remember(tasks: Set<string>, id: string): void {
  tasks.delete(id);
  tasks.add(id);
  for (const old of tasks) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(old);
  }
}
export function rememberTask(state: GateState, id: string): void {
  remember(state.tasks, id);
}
// The main loop's own background command starts with its result's id and ends with its
// notification, or with its TaskStop, which sends none.
export function trackMainTask(
  state: GateState,
  e: { tool: string; task_id?: unknown },
  task: { id: string } | undefined,
): void {
  if (e.tool === "TaskStop" && typeof e.task_id === "string") {
    state.mainTasks.delete(e.task_id);
    state.mainAgents.delete(e.task_id);
  }
  if (task !== undefined) remember(state.mainTasks, task.id);
}
// The Agent tool's background launch; its notification's task id is the agent's id.
export function trackMainAgent(state: GateState, result: { result?: unknown }): void {
  const output = result.result;
  if (typeof output !== "object" || output === null) return;
  if (!("status" in output) || output.status !== "async_launched") return;
  if ("agentId" in output && typeof output.agentId === "string")
    remember(state.mainAgents, output.agentId);
}
export function finishMainTask(state: GateState, e: { text: string; origin: { kind: string } }) {
  const task = e.origin.kind === "task-notification" ? TASK_ID.exec(e.text)?.[1] : undefined;
  if (task === undefined) return;
  state.mainTasks.delete(task);
  state.mainAgents.delete(task);
}
const LIVE = new Set(["pending", "running", "waiting"]);
// Subagents the main loop started that have not ended, or whose notification has not reached it;
// the Mod's reviewers are not the session's.
export function runningAgents(
  state: GateState,
  agents: readonly { id: string; status: string; parentId?: string; spawnedBy?: string }[],
): number {
  return agents.filter(
    (agent) =>
      agent.parentId === undefined &&
      agent.spawnedBy !== "cerberus-gate" &&
      !state.reviewers.has(agent.id) &&
      (LIVE.has(agent.status) || state.mainAgents.has(agent.id)),
  ).length;
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
