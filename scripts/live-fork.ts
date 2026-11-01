import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Observe the real fork API; only explicit failure/latency fixtures replace or delay its result.
export function forkFixture(mode: string, artifacts: string): string {
  return `on('model.fork',async($,e,next)=>{
    const index=++review;
    await $.fs.write(${JSON.stringify(artifacts)}+'/review-start-'+index+'.json',JSON.stringify({request:e,at:Date.now()}));
    if(${JSON.stringify(mode)}==='reload-review' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','review');await $.clock.sleep(7000);}
    if(['cancel','timeout'].includes(${JSON.stringify(mode)}))await $.clock.sleep(7000);
    const result=${JSON.stringify(mode)}==='unverified'
      ? {value:{isAnswered:true,text:'INVALID_REVIEW',usage:{}}}
      : ${JSON.stringify(mode)}==='cap'
      ? {value:{isAnswered:true,text:JSON.stringify({decision:'REVISE',findings:['fact.txt:1 says stable; re-present the successful read and correct the claim.']}),usage:{}}}
      : await next(e);
    await $.fs.write(${JSON.stringify(artifacts)}+'/review-'+index+'.json',JSON.stringify({request:e,result:result.value,at:Date.now()}));return result;
  });`;
}

export async function verifyFork(artifacts: string, mode: string, screen: string) {
  if (mode === "timeout" && screen.includes("[PASS]"))
    throw new Error("Late fork published PASS after timeout");
  if (mode === "cancel" && /⏺\s+stable\b/u.test(screen))
    throw new Error("Cancelled fork published its answer");
  const records = await readdir(artifacts);
  const reviews = await Promise.all(
    records
      .filter((n) => /^review-\d+\.json$/u.test(n))
      .map(async (n) => JSON.parse(await readFile(join(artifacts, n), "utf8"))),
  );
  if (!reviews.length && mode !== "reload-review") throw new Error("No fork result");
  if (records.some((n) => /^material-\d+\.json$/u.test(n)))
    throw new Error("Fork generated materials");
  const tools = await Promise.all(
    records
      .filter((n) => /^tool-\d+\.json$/u.test(n))
      .map(async (n) => JSON.parse(await readFile(join(artifacts, n), "utf8"))),
  );
  if (tools.some((t) => t.origin.plugin === "cerberus-gate"))
    throw new Error("Fork ran investigation tools");
  const decisions = reviews.map((r) => {
    try {
      return JSON.parse(r.result.text).decision;
    } catch {
      return undefined;
    }
  });
  if (
    [
      "pass",
      "revise",
      "question-pass",
      "question-revise",
      "cli",
      "history",
      "bounds",
      "environment",
      "causal",
      "choice",
    ].includes(mode) &&
    !decisions.includes("PASS")
  )
    throw new Error("No real fork PASS");
  if (
    ["revise", "question-revise", "history", "bounds", "environment", "causal"].includes(mode) &&
    !decisions.includes("REVISE")
  )
    throw new Error("Missing fork REVISE");
  if (mode === "choice" && decisions.includes("REVISE"))
    throw new Error("Unresolved specification choice was rejected");
  if (mode === "cap" && (reviews.length !== 2 || !screen.includes("[UNVERIFIED]")))
    throw new Error("Cap did not review final correction");
}

export async function verifyForkDiscard(reports: { directory: string }[], mode: string) {
  if (mode !== "timeout" && mode !== "cancel") return;
  const events = [];
  for (const report of reports) {
    const index = (await readFile(join(report.directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of index.filter((item) => item.kind === "instance")) {
      const rows = (await readFile(join(report.directory, entry.path), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      events.push(...rows);
    }
  }
  if (!events.some((event) => event.event === "model.discarded" && event.data.response?.usage))
    throw new Error("Missing late fork discard and usage");
}
