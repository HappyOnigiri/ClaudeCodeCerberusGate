import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Include main work and correction turns, not only reviewer usage. Preserve each raw usage too.
export async function recordMetrics(artifacts: string, method: string) {
  const records = await readdir(artifacts);
  const load = async (pattern: RegExp) =>
    Promise.all(
      records
        .filter((n) => pattern.test(n))
        .map(async (n) => JSON.parse(await readFile(join(artifacts, n), "utf8"))),
    );
  const steps = await load(/^step-/u);
  const reviews = await load(/^review-\d+\.json$/u);
  const tools = await load(/^tool-\d+\.json$/u);
  const totalUsage: Record<string, number> = {};
  const usage = [...steps.map((s) => s.result.usage), ...reviews.map((r) => r.result.usage)];
  for (const entry of usage)
    for (const [key, value] of Object.entries(entry ?? {}))
      if (typeof value === "number") totalUsage[key] = (totalUsage[key] ?? 0) + value;
  const mainReads = tools.filter(
    (t) => t.tool === "Read" && !t.input.agentId && t.origin.plugin !== "cerberus-gate",
  );
  await writeFile(
    join(artifacts, "metrics.json"),
    JSON.stringify(
      {
        method,
        mainCalls: steps.length,
        reviewCalls: reviews.length,
        totalUsage,
        usage,
        mainTools: tools.filter((t) => !t.input.agentId && t.origin.plugin !== "cerberus-gate")
          .length,
        reviewerTools: tools.filter((t) => t.origin.plugin === "cerberus-gate").length,
        repeatedMainReads: mainReads.length - new Set(mainReads.map((t) => t.input.file_path)).size,
        decisions: reviews.map((r) => {
          try {
            return JSON.parse(r.result.text).decision;
          } catch {
            return "invalid";
          }
        }),
        failures: reviews.filter((r) => !r.result.isAnswered).map((r) => r.result.reason),
      },
      null,
      2,
    ),
  );
}
