import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface ToolRecord {
  tool: string;
  input: { file_path?: string };
  origin: { plugin?: string };
  result: { deny?: string; isError?: boolean };
}
interface EvidenceEntry {
  tool: string;
  input: { file_path?: string };
  result: string;
  isError?: boolean;
}

const read = async <T>(artifacts: string, name: string): Promise<T> =>
  JSON.parse(await readFile(join(artifacts, name), "utf8"));
const missing = (path = "") => path.endsWith("missing-fact.txt");

// A real failed reviewer Read must reach the reviewer as evidence and be followed by a successful retry.
export async function verifyRecovery(records: string[], artifacts: string) {
  const calls = await Promise.all(
    records
      .filter((name) => /^tool-\d+\.json$/u.test(name))
      .toSorted((a, b) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]))
      .map((name) => read<ToolRecord>(artifacts, name)),
  );
  const reviewer = calls.filter((call) => call.origin.plugin === "cerberus-gate");
  const failed = reviewer.findIndex(
    (call) => call.tool === "Read" && missing(call.input.file_path) && call.result.isError,
  );
  if (failed < 0) throw new Error("Reviewer did not hit a real Read execution error");
  if (
    !reviewer
      .slice(failed + 1)
      .some(
        (call) =>
          call.tool === "Read" &&
          call.input.file_path?.endsWith("fact.txt") &&
          !missing(call.input.file_path) &&
          call.result.deny === undefined &&
          !call.result.isError,
      )
  )
    throw new Error("Reviewer did not retry with a successful Read after the error");
  const reviews = await Promise.all(
    records
      .filter((name) => /^review-\d+\.json$/u.test(name))
      .map((name) => read<{ request: { prompt: string } }>(artifacts, name)),
  );
  const returned = reviews.some((review) =>
    JSON.parse(review.request.prompt.split("\nBefore deciding,")[0]!).evidence.some(
      (entry: EvidenceEntry) =>
        entry.tool === "Read" && missing(entry.input.file_path) && entry.isError === true,
    ),
  );
  if (!returned) throw new Error("Execution error was not returned to the reviewer as evidence");
}
