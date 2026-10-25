interface DebugRecord {
  kind: string;
  path: string;
  instanceId: string;
  event: string;
  sequence: number;
  sessionId: string;
  batch: number;
  bytes: number;
  lines: number;
  data: {
    cwd: string;
    request: { prompt: string; system: string };
    operationId: string;
    elapsedMs: number;
    reason: unknown;
  };
}
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { expand } from "../plugins/cerberus-gate/hooks/session-log.mts";

const jsonl = async (path: string): Promise<DebugRecord[]> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
// Select this disposable workspace's session using the independently recorded host cwd.
export async function verifyDebug(work: string, artifacts: string, installedConfig?: string) {
  const expected = await realpath(work);
  const roots = installedConfig
    ? [installedConfig]
    : [join(work, "config"), process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")];
  const report = [];
  for (const config of roots) {
    const root = await realpath(join(config, "cerberus-gate/debug")).catch(() => undefined);
    if (!root) continue;
    for (const session of await readdir(root).catch(() => [])) {
      const directory = join(root, session);
      const index = await jsonl(join(directory, "index.jsonl"));
      const instances = [];
      for (const entry of index.filter((item) => item.kind === "instance")) {
        const path = join(directory, entry.path);
        const events = await jsonl(path);
        if (!events.some((item) => item.event === "session.start" && item.data.cwd === expected))
          continue;
        if ((await stat(path)).mode & 0o077) throw new Error("Debug log permissions");
        if (
          !events.every(
            (item, i) =>
              item.sequence === i + 1 &&
              item.sessionId === session &&
              item.instanceId === entry.instanceId,
          )
        )
          throw new Error("Debug event identity/order");
        for (const start of events.filter((item) => item.event === "model.start")) {
          if (!start.data.request.prompt || !start.data.request.system)
            throw new Error("Missing full model request");
          const terminal = events.find(
            (item) =>
              ["model.complete", "model.discarded", "review.failed"].includes(item.event) &&
              item.data.operationId === start.data.operationId,
          );
          // An unloaded instance can end at a start record; require a replacement instance in that case.
          if (!terminal && index.filter((item) => item.kind === "instance").length < 2)
            throw new Error("Model operation missing terminal event");
        }
        const material = index.filter(
          (item) => item.kind === "material" && item.instanceId === entry.instanceId,
        );
        for (const record of material) {
          const materialPath = join(directory, record.path);
          if ((await stat(materialPath)).mode & 0o077) throw new Error("Material permissions");
          if (record.path.endsWith("source.jsonl")) {
            const source = await readFile(materialPath, "utf8");
            if (
              Buffer.byteLength(source) !== record.bytes ||
              source.split("\n").length - 1 !== record.lines
            )
              throw new Error("Material boundary mismatch");
            const rendered = expand(source, session);
            for (const name of ["users", "history"] as const)
              if (
                (await readFile(join(materialPath, "..", name + ".txt"), "utf8")) !== rendered[name]
              )
                throw new Error("Material expansion mismatch");
          }
        }
        const starts = events.filter((item) => item.event === "model.start");
        const ends = events.filter((item) => item.event === "model.complete");
        instances.push({
          instanceId: entry.instanceId,
          events: events.length,
          batches: new Set(events.map((item) => item.batch).filter(Boolean)).size,
          models: starts.length,
          modelElapsedMs: ends.reduce((sum, item) => sum + item.data.elapsedMs, 0),
          materials: material.length,
          reasons: events
            .filter((item) =>
              ["review.failed", "review.unverified", "verdict.parsed"].includes(item.event),
            )
            .map((item) => item.data.reason),
        });
      }
      if (instances.length) report.push({ sessionId: session, directory, instances });
    }
  }
  if (!report.length) throw new Error("No persisted debug session matched live workspace");
  await writeFile(join(artifacts, "persisted-debug.json"), JSON.stringify(report, null, 2));
  return report;
}
