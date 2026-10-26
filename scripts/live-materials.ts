interface Evidence {
  tool: string;
  input: { file_path?: string; path?: string; command?: string };
  result: string;
}
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const decisionOf = (text: string) => {
  try {
    return JSON.parse(text).decision;
  } catch {
    return undefined;
  }
};

// Audit the real review inputs, returned evidence and lifecycle independently of the TUI.
export async function verifyMaterials(records: string[], artifacts: string, mode: string) {
  if (mode === "missing-log" && records.some((entry) => /^review-\d+\.json$/u.test(entry)))
    throw new Error("Unavailable log started a reviewer");
  const snapshots = new Map();
  let cliHistorySearched = false;
  for (const name of records.filter((entry) => /^review-\d+\.json$/u.test(entry))) {
    const review = JSON.parse(await readFile(join(artifacts, name), "utf8"));
    const input = JSON.parse(review.request.prompt.split("\n")[0]);
    if (input.conversation !== undefined || !input.sessionLog?.source)
      throw new Error("Missing searchable log input");
    snapshots.set(input.sessionLog.source, input.sessionLog);
    if (mode === "cli") {
      if (input.tools.some((tool: { name: string }) => tool.name === "Grep"))
        throw new Error("Grep was advertised in the CLI review");
      cliHistorySearched ||= input.evidence.some(
        (e: Evidence) =>
          e.tool === "Bash" &&
          e.input.command?.startsWith("grep ") &&
          e.input.command?.includes(input.sessionLog.history) &&
          e.result.length > 0,
      );
    }
    if (
      decisionOf(review.result.text) === "PASS" &&
      !input.evidence.some(
        (e: Evidence) =>
          e.tool === "Read" && e.input.file_path === input.sessionLog.users && e.result.length,
      )
    )
      throw new Error("Reviewer passed without reading user history");
  }
  if (mode === "cli" && !cliHistorySearched)
    throw new Error("No successful CLI history search without Grep");
  for (const snapshot of snapshots.values()) {
    if (existsSync(snapshot.directory)) throw new Error("Review materials survived completion");
  }
  if (mode === "history") {
    const materials = await Promise.all(
      records
        .filter((entry) => /^material-\d+\.json$/u.test(entry))
        .map(async (entry) => JSON.parse(await readFile(join(artifacts, entry), "utf8"))),
    );
    if (
      !materials.some(
        (m) =>
          m.users.includes("Correction: report") &&
          m.users.includes("ORCHID") &&
          m.history.includes("export const LIMIT = 7;") &&
          m.raw.includes("tool_result"),
      )
    )
      throw new Error(
        "Standard JSONL did not contain the old user constraint and completed tool result",
      );
    const reviews = await Promise.all(
      records
        .filter((name) => /^review-\d+\.json$/u.test(name))
        .map(async (name) => JSON.parse(await readFile(join(artifacts, name), "utf8"))),
    );
    const revised = reviews.find((r) => {
      try {
        return JSON.parse(r.result.text).decision === "REVISE";
      } catch {
        return false;
      }
    });
    if (!revised || !/ORCHID/u.test(revised.result.text) || !/7/u.test(revised.result.text))
      throw new Error("History review did not identify both the old constraint and allowed value");
    if (
      !reviews.some((r) =>
        JSON.parse(r.request.prompt.split("\n")[0]).evidence.some(
          (e: Evidence) =>
            (e.input.file_path?.endsWith("history.txt") || e.input.path?.endsWith("history.txt")) &&
            e.result.includes("export const LIMIT = 7"),
        ),
      )
    )
      throw new Error("No actual expanded-history exploration");
  }
}
