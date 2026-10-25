import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const root = process.cwd();
const report = resolve(root, "tmp/live-probe", new Date().toISOString().replaceAll(":", "-"));
await mkdir(report, { recursive: true });
const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["pass", "search", "revise", "unverified", "cancel", "slow", "timeout"];
const tmux = (...args) =>
  execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const submit = async (session, text) => {
  tmux("send-keys", "-t", session, "-l", text);
  await pause(500);
  // ユーザーの Enter=改行設定にも対応する。通常設定では Enter を使う。
  tmux(
    "send-keys",
    "-t",
    session,
    "-l",
    process.env.CERBERUS_SUBMIT === "enter" ? "\r" : "\x1b[13;5u",
  );
  await pause(500);
};
const summary = [];
for (const mode of cases) {
  if (!["pass", "search", "revise", "unverified", "cancel", "slow", "timeout"].includes(mode))
    throw new Error(`Unknown case ${mode}`);
  const work = await mkdtemp(join(tmpdir(), "cerberus-live-"));
  const artifacts = join(report, mode);
  await mkdir(artifacts, { recursive: true });
  const plugin = join(work, "gate");
  await cp(join(root, "plugins/cerberus-gate"), plugin, {
    recursive: true,
    filter: (p) => !p.includes("/.claude-plugin/types"),
  });
  const fixture = join(work, "fixture");
  await mkdir(join(fixture, ".claude-plugin"), { recursive: true });
  await mkdir(join(fixture, "hooks"));
  await writeFile(
    join(fixture, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "cerberus-probe-fixture",
      version: "0.0.1",
      description: "Disposable live verification fixture",
      author: { name: "HappyOnigiri" },
    }),
  );
  await writeFile(
    join(fixture, "hooks/hooks.json"),
    JSON.stringify({ modules: ["./register.ts"] }),
  );
  await writeFile(
    join(fixture, "hooks/register.ts"),
    `
 let first=true,review=0,prompts=0,tools=0;
 export const register=on=>{
  on('turn.step',async function*($,e,next){
   if(!e.agentId && first && ${JSON.stringify(mode)}==='revise'){
    first=false;
    const text='The release channel is beta. CERBERUS_REJECTED_DRAFT';
    yield {kind:'text',index:0,text};yield {kind:'stop',stopReason:'end_turn',usage:null};
    return {turnId:e.turnId,index:e.index,answer:text,toolUses:[],stopReason:'end_turn',usage:null};
   }
   const stream=next(e);const pieces=[];for await(const c of stream){pieces.push(c);yield c;}
   const result=await stream.result;
   await $.fs.write(${JSON.stringify(artifacts)}+'/step-'+(e.agentId??'main')+'-'+e.turnId+'-'+e.index+'.json',JSON.stringify({event:e,result,pieces}));
   return result;
  });
  on('prompt.submit',async($,e,next)=>{
   await $.fs.write(${JSON.stringify(artifacts)}+'/prompt-'+(++prompts)+'.json',JSON.stringify(e));return next(e);
  });
  on('model.complete',async($,e,next)=>{
   const index=++review;
   await $.fs.write(${JSON.stringify(artifacts)}+'/review-start-'+index+'.json',JSON.stringify({at:Date.now(),request:e}));
   if(['cancel','timeout'].includes(${JSON.stringify(mode)}))await $.clock.sleep(7000);
   if(${JSON.stringify(mode)}==='slow')await $.clock.sleep(6000);
   if(${JSON.stringify(mode)}==='search')e={...e,prompt:e.prompt+'\\nBefore deciding, the evidence array must contain successful results from both Glob (find **/fact.txt) and Grep (search stable in fact.txt). If Glob is already in evidence, request Grep next; if both exist, return the verdict. Do not repeat completed searches.'};
   const result=${JSON.stringify(mode)}==='unverified'
    ? {value:{isAnswered:true,text:'INVALID_REVIEW',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}
    : await next(e);
   await $.fs.write(${JSON.stringify(artifacts)}+'/review-'+index+'.json',JSON.stringify({request:e,result:result.value,at:Date.now()}));
   return result;
  });
  on('tool.call',async($,e,next)=>{
   const result=await next(e);
   await $.fs.write(${JSON.stringify(artifacts)}+'/tool-'+(++tools)+'.json',JSON.stringify({tool:e.tool,origin:next.origin,result}));return result;
  });
  on('turn.complete',async($,e,next)=>{
   await $.fs.write(${JSON.stringify(artifacts)}+'/complete-'+e.turnId+'.json',JSON.stringify(e));return next(e);
  });
  on('session.end',async($,e,next)=>{
   await $.fs.write(${JSON.stringify(artifacts)}+'/session-end.json',JSON.stringify(e));return next(e);
  });
 };
 `,
  );
  const delay = join(work, "delay");
  if (mode === "slow") {
    await mkdir(join(delay, ".claude-plugin"), { recursive: true });
    await mkdir(join(delay, "hooks"));
    await writeFile(
      join(delay, ".claude-plugin/plugin.json"),
      JSON.stringify({
        name: "cerberus-probe-delay",
        version: "0.0.1",
        description: "Slow review fixture",
      }),
    );
    await writeFile(
      join(delay, "hooks/hooks.json"),
      JSON.stringify({ modules: ["./register.ts"] }),
    );
    await writeFile(
      join(delay, "hooks/register.ts"),
      `export const register=on=>on('model.complete',async($,e,next)=>{await $.clock.sleep(6000);return next(e);});`,
    );
  }
  if (mode === "timeout") {
    const path = join(plugin, "hooks/register.ts");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace(
        "config = readConfig(options)",
        "config = readConfig({...options, reviewTimeoutSeconds:1})",
      ),
    );
  }
  await writeFile(join(work, "fact.txt"), "The release channel is stable.\n");
  const session = `cerberus-${mode}-${process.pid}`;
  const args = [
    "claude",
    "--model",
    "haiku",
    "--permission-mode",
    "default",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "SubagentHandback",
    "--plugin-dir",
    plugin,
    "--plugin-dir",
    fixture,
    ...(mode === "slow" ? ["--plugin-dir", delay] : []),
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--system-prompt",
    "Follow the user request. Use Read for files.",
    "--debug-file",
    join(artifacts, "debug.log"),
  ];
  let started = false;
  try {
    tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "140",
      "-y",
      "45",
      "-c",
      work,
      args.map(quote).join(" "),
    );
    started = true;
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline) {
      const screen = tmux("capture-pane", "-p", "-t", session, "-S", "-200");
      if (screen.includes("Yes, I trust this folder")) {
        tmux("send-keys", "-t", session, "Down", "Enter");
        await pause(500);
      } else if (screen.includes("Allow external CLAUDE.md file imports")) {
        tmux("send-keys", "-t", session, "Enter");
        await pause(500);
      } else if (screen.includes("Try ") || screen.includes("❯")) {
        ready = true;
        break;
      }
      await pause(500);
    }
    if (!ready) throw new Error("TUI did not become ready");
    await submit(
      session,
      "Read fact.txt and reply with exactly the release channel, with no other text.",
    );
    let cancelled = false;
    let passed = false;
    let latest = "";
    while (Date.now() < deadline) {
      latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      await writeFile(join(artifacts, "screen.txt"), latest);
      if (latest.includes("CERBERUS_REJECTED_DRAFT") || latest.includes("INVALID_REVIEW"))
        throw new Error("Private draft or verdict leaked to the TUI");
      if (/\berror\b|hook skipped|hook failed|hooks module did not load/iu.test(latest))
        throw new Error("Hook error in TUI");
      if (mode === "cancel" && !cancelled && latest.includes("回答を検証中です。")) {
        await submit(session, "/cgate log");
        // The command runs immediately but its transcript row may wait for the held turn's flush.
        // Cancel before waiting for that row, so the review is still in flight.
        await submit(session, "/cgate cancel");
        cancelled = true;
        await pause(8500);
        continue;
      }
      if (mode === "cancel" && latest.includes("cancelled")) {
        passed = true;
        break;
      }
      if (
        (mode === "unverified" || mode === "timeout") &&
        latest.includes("未検証の本文をそのまま表示します") &&
        /\bstable\b/u.test(latest)
      ) {
        passed = true;
        break;
      }
      if (
        (mode === "pass" || mode === "search" || mode === "revise" || mode === "slow") &&
        /⏺\s+stable\b/u.test(latest)
      ) {
        passed = true;
        break;
      }
      await pause(500);
    }
    if (!passed) throw new Error("Expected completion not observed before deadline");
    await submit(session, "/cgate log");
    const logDeadline = Date.now() + 15_000;
    let logSeen = false;
    while (Date.now() < logDeadline) {
      latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      const expected = {
        pass: "検証済みの本文を公開しました。",
        search: "検証済みの本文を公開しました。",
        slow: "検証済みの本文を公開しました。",
        timeout: "タイムアウト",
        revise: "修正を依頼しました",
        unverified: "UNVERIFIED",
        cancel: "コマンドで検証処理を取り消しました。",
      }[mode];
      if (latest.includes("このセッションのログ（時刻は UTC）") && latest.includes(expected)) {
        logSeen = true;
        break;
      }
      await pause(250);
    }
    await writeFile(join(artifacts, "log-screen.txt"), latest);
    if (!logSeen) throw new Error("Expected session log not observed");
    if (!/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/u.test(latest))
      throw new Error("UTC timestamp not observed in session log");
    if (latest.includes("CERBERUS_REJECTED_DRAFT") || latest.includes("INVALID_REVIEW"))
      throw new Error("Private draft or verdict leaked through session log");
    if (mode === "pass") {
      // 末尾の空白でコマンド候補のメニューを閉じてから送信する。
      await submit(session, "/clear ");
      const clearDeadline = Date.now() + 10_000;
      while (!(await readdir(artifacts)).includes("session-end.json")) {
        if (Date.now() >= clearDeadline) throw new Error("/clear did not end the session");
        await pause(250);
      }
      await submit(session, "/cgate log");
      const screen = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      await writeFile(join(artifacts, "clear-screen.txt"), screen);
      if (!screen.includes("このセッションのログはありません。"))
        throw new Error("Session log survived /clear");
    }
    if (mode === "cancel" && !latest.includes("審査 #1: 開始"))
      throw new Error("Pending review log not observed");
    if (mode === "cancel" && /⏺\s+stable\b/u.test(latest))
      throw new Error("Cancelled answer published");
    if ((await readFile(join(work, "fact.txt"), "utf8")) !== "The release channel is stable.\n")
      throw new Error("Evidence modified");
    const records = await readdir(artifacts);
    const verdicts = [];
    const origins = [];
    for (const name of records) {
      if (/^review-\d+\.json$/u.test(name)) {
        const review = JSON.parse(await readFile(join(artifacts, name), "utf8"));
        verdicts.push(review.result.text ?? "");
      }
      if (name.startsWith("prompt-"))
        origins.push(JSON.parse(await readFile(join(artifacts, name), "utf8")).origin);
    }
    const pluginPrompts = origins.filter(
      (origin) => origin.kind === "plugin" && origin.name === "cerberus-gate",
    ).length;
    if (mode === "revise" && !verdicts.some((v) => v.includes('"REVISE"')))
      throw new Error("No real reviewer REVISE verdict observed");
    const revisions = verdicts.filter((text) => {
      try {
        return JSON.parse(text).decision === "REVISE";
      } catch {
        return false;
      }
    }).length;
    if (mode === "revise" ? revisions < 1 || pluginPrompts !== revisions : pluginPrompts !== 0)
      throw new Error(`Unexpected control prompt count: ${pluginPrompts}`);
    if (mode === "search") {
      const calls = [];
      for (const name of records.filter((entry) => entry.startsWith("tool-")))
        calls.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
      for (const tool of ["Grep", "Glob"])
        if (
          !calls.some(
            (call) =>
              call.tool === tool &&
              call.origin.plugin === "cerberus-gate" &&
              call.result.deny === undefined &&
              !call.result.isError,
          )
        )
          throw new Error(`Reviewer did not use ${tool}`);
    }
    if (mode === "slow") {
      const start = JSON.parse(await readFile(join(artifacts, "review-start-1.json"), "utf8"));
      const end = JSON.parse(await readFile(join(artifacts, "review-1.json"), "utf8"));
      if (end.at - start.at < 10000) throw new Error("Slow review did not exceed ten seconds");
    }
    summary.push({ case: mode, status: "PASS", workspace: work, pluginPrompts });
    console.log(`PASS ${mode}`);
  } catch (error) {
    if (started)
      await writeFile(
        join(artifacts, "failure-screen.txt"),
        tmux("capture-pane", "-p", "-t", session, "-S", "-1000"),
      );
    summary.push({ case: mode, status: "FAIL", error: String(error), workspace: work });
    console.error(`FAIL ${mode}: ${String(error)}`);
    process.exitCode = 1;
  } finally {
    if (started) tmux("kill-session", "-t", session);
  }
}
await writeFile(
  join(report, "report.json"),
  JSON.stringify(
    {
      claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
      model: "haiku",
      cases: summary,
    },
    null,
    2,
  ),
);
console.log(`Report: ${report}`);
