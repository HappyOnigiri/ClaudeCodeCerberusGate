import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const root = process.cwd();
const report = resolve(root, "tmp/live-probe", new Date().toISOString().replaceAll(":", "-"));
await mkdir(report, { recursive: true });
const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["pass", "model", "search", "revise", "unverified", "cancel", "reload-work", "reload-review"];
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
  if (
    ![
      "pass",
      "model",
      "search",
      "revise",
      "unverified",
      "cancel",
      "reload-work",
      "reload-review",
    ].includes(mode)
  )
    throw new Error(`Unknown case ${mode}`);
  const work = await mkdtemp(join(tmpdir(), "cerberus-live-"));
  const artifacts = join(report, mode);
  await mkdir(artifacts, { recursive: true });
  const plugin = join(work, "gate");
  await cp(join(root, "plugins/cerberus-gate"), plugin, {
    recursive: true,
    filter: (p) => !p.includes("/.claude-plugin/types"),
  });
  const configDir = join(work, "config");
  const settings = join(configDir, "settings.json");
  const reloadSettings = (maxRevisions) =>
    JSON.stringify({ pluginConfigs: { "cerberus-gate@inline": { options: { maxRevisions } } } });
  if (mode === "reload-work" || mode === "model") {
    await mkdir(configDir);
    const accountPath = process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : join(homedir(), ".claude.json");
    const original = JSON.parse(await readFile(accountPath, "utf8"));
    const account = Object.fromEntries(
      ["oauthAccount", "hasCompletedOnboarding", "lastOnboardingVersion", "theme"]
        .filter((key) => original[key] !== undefined)
        .map((key) => [key, original[key]]),
    );
    await writeFile(join(configDir, ".claude.json"), JSON.stringify(account));
    await writeFile(
      settings,
      mode === "model"
        ? JSON.stringify({
            pluginConfigs: { "cerberus-gate@inline": { options: { reviewerEffort: "low" } } },
          })
        : reloadSettings(2),
    );
  }
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
 let first=true;
 export const register=on=>{
  on('agent.spawn',async($,e,next)=>next(${JSON.stringify(mode)}==='search' ? {...e,prompt:e.prompt+'\\nBefore deciding, use Glob to find **/fact.txt and Grep to search for stable in fact.txt. Both searches are required evidence.'} : e));
  on('turn.step',async function*($,e,next){
   if(e.agentId && ${JSON.stringify(mode)}==='reload-review' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','review');
    await $.clock.sleep(12000);
   }
   if(!e.agentId && first && ${JSON.stringify(mode)}==='revise'){
    first=false;
    const text='The release channel is beta. CERBERUS_REJECTED_DRAFT';
    yield {kind:'text',index:0,text};yield {kind:'stop',stopReason:'end_turn',usage:null};
    return {turnId:e.turnId,index:e.index,answer:text,toolUses:[],stopReason:'end_turn',usage:null};
   }
   if(e.agentId && ${JSON.stringify(mode)}==='cancel')await $.clock.sleep(7000);
   if(e.agentId && ${JSON.stringify(mode)}==='unverified'){
    yield {kind:'text',index:0,text:'INVALID_REVIEW'};yield {kind:'stop',stopReason:'end_turn',usage:null};
    return {turnId:e.turnId,index:e.index,answer:'INVALID_REVIEW',toolUses:[],stopReason:'end_turn',usage:null};
   }
   const stream=next(e);const pieces=[];for await(const c of stream){pieces.push(c);yield c;}
   const result=await stream.result;
   await $.fs.write(${JSON.stringify(artifacts)}+'/step-'+(e.agentId??'main')+'-'+e.turnId+'-'+e.index+'.json',JSON.stringify({event:e,result,pieces}));
   return result;
  });
  on('tool.call',{tool:'Read'},async($,e,next)=>{
   const result=await next(e);
   if(!e.agentId && ${JSON.stringify(mode)}==='reload-work' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','work');
    await $.clock.sleep(7000);
   }
   return result;
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
    "--setting-sources",
    mode === "reload-work" || mode === "model" ? "user,project,local" : "project,local",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--system-prompt",
    "Follow the user request. Use Read for files.",
    "--debug-file",
    join(artifacts, "debug.log"),
  ];
  if (mode === "reload-work" || mode === "model")
    args.unshift(
      "env",
      `CLAUDE_CONFIG_DIR=${configDir}`,
      `CLAUDE_SECURESTORAGE_CONFIG_DIR=${process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? ""}`,
    );
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
    if (mode === "model") {
      await submit(session, "/cgate model");
      await pause(1000);
      await writeFile(
        join(artifacts, "model-picker.txt"),
        tmux("capture-pane", "-p", "-t", session, "-S", "-200"),
      );
      tmux("send-keys", "-t", session, "Down", "Enter");
      const savedDeadline = Date.now() + 15_000;
      let saved;
      while (Date.now() < savedDeadline) {
        saved = JSON.parse(await readFile(settings, "utf8"));
        if (
          Object.values(saved.pluginConfigs ?? {}).some((p) => p.options?.reviewerModel === "haiku")
        )
          break;
        await pause(250);
      }
      if (
        !Object.values(saved.pluginConfigs ?? {}).some((p) => p.options?.reviewerModel === "haiku")
      )
        throw new Error("Model selection was not persisted to user settings");
      await writeFile(join(artifacts, "saved-settings.json"), JSON.stringify(saved, null, 2));
    }
    await submit(
      session,
      "Read fact.txt and reply with exactly the release channel, with no other text.",
    );
    let reloaded = false;
    let cancelled = false;
    let passed = false;
    let latest = "";
    while (Date.now() < deadline) {
      latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      await writeFile(join(artifacts, "screen.txt"), latest);
      if (!reloaded && (await readdir(artifacts)).includes("reload-ready")) {
        await writeFile(join(artifacts, "reloaded"), "yes");
        if (mode === "reload-work") await writeFile(settings, reloadSettings(3));
        else {
          const module = join(plugin, "hooks/register.ts");
          await writeFile(module, (await readFile(module, "utf8")) + "\n// live reload probe\n");
        }
        reloaded = true;
      }
      if (latest.includes("CERBERUS_REJECTED_DRAFT") || latest.includes("INVALID_REVIEW"))
        throw new Error("Private draft or verdict leaked to the TUI");
      if (/\berror\b|hook skipped|hook failed/iu.test(latest)) throw new Error("Hook error in TUI");
      if (mode === "cancel" && !cancelled && latest.includes("回答を検証中です。")) {
        await submit(session, "/cgate log");
        const logDeadline = Date.now() + 10_000;
        let pendingLogSeen = false;
        while (Date.now() < logDeadline) {
          const screen = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
          if (screen.includes("このセッションのログ（時刻は UTC）")) {
            pendingLogSeen = true;
            break;
          }
          await pause(250);
        }
        if (!pendingLogSeen) throw new Error("Pending review log not observed");
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
        mode === "unverified" &&
        latest.includes("未検証の本文をそのまま表示します") &&
        /\bstable\b/u.test(latest)
      ) {
        passed = true;
        break;
      }
      if (
        (mode === "pass" ||
          mode === "model" ||
          mode === "search" ||
          mode === "revise" ||
          mode.startsWith("reload-")) &&
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
        model: "検証済みの本文を公開しました。",
        search: "検証済みの本文を公開しました。",
        revise: "修正を依頼しました",
        unverified: "UNVERIFIED",
        cancel: "コマンドで検証処理を取り消しました。",
        "reload-work": "検証済みの本文を公開しました。",
        "reload-review": "検証済みの本文を公開しました。",
      }[mode];
      if (latest.includes("このセッションのログ（時刻は UTC）") && latest.includes(expected)) {
        logSeen = true;
        break;
      }
      await pause(250);
    }
    await writeFile(join(artifacts, "log-screen.txt"), latest);
    if (!logSeen) throw new Error("Expected session log not observed");
    if (mode.startsWith("reload-")) {
      if (!reloaded || !latest.includes("再ロード前の依頼と修正回数を復元しました。"))
        throw new Error("Reload recovery not observed");
      if (
        mode === "reload-review" &&
        !latest.includes("再ロードで中断した回答の再生成・再審査を依頼します。")
      )
        throw new Error("Interrupted review did not restart");
      if (
        mode === "reload-work" &&
        latest.includes("再ロードで中断した回答の再生成・再審査を依頼します。")
      )
        throw new Error("Work reload happened after review started");
    }
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
    if (mode === "cancel" && /⏺\s+stable\b/u.test(latest))
      throw new Error("Cancelled answer published");
    if ((await readFile(join(work, "fact.txt"), "utf8")) !== "The release channel is stable.\n")
      throw new Error("Evidence modified");
    const steps = [];
    for (const name of await readdir(artifacts))
      if (name.startsWith("step-"))
        steps.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
    if (mode === "model" || mode === "pass") {
      const reviews = steps.filter((s) => s.event.agentId);
      if (!reviews.length) throw new Error("No real reviewer step observed");
      const main = steps.find((s) => !s.event.agentId);
      if (!main) throw new Error("No main answer step observed");
      for (const review of reviews) {
        if (review.event.model !== main.event.model)
          throw new Error("Reviewer model did not match haiku");
        if (review.event.effort !== (mode === "model" ? "low" : main.event.effort))
          throw new Error("Reviewer effort did not match the configured or inherited effort");
      }
    }
    if (mode === "search") {
      const tools = steps
        .filter((s) => s.event.agentId)
        .flatMap((s) => s.result.toolUses.map((t) => t.name));
      for (const tool of ["Grep", "Glob"])
        if (!tools.includes(tool)) throw new Error(`Reviewer did not use ${tool}`);
    }
    const rawVerdicts = steps
      .flatMap((s) => [
        ...(s.result.toolUses ?? []),
        { name: "SubagentHandback", input: { message: s.result.answer } },
      ])
      .filter((t) => t.name === "SubagentHandback")
      .map((t) => t.input.message);
    if (mode === "revise" && !rawVerdicts.some((v) => v.includes("REVISE")))
      throw new Error("No real reviewer REVISE verdict observed");
    summary.push({ case: mode, status: "PASS", workspace: work });
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
