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
  : [
      "pass",
      "model",
      "search",
      "revise",
      "unverified",
      "cancel",
      "slow",
      "timeout",
      "reload-work",
      "reload-review",
    ];
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
      "slow",
      "timeout",
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
            pluginConfigs: { "cerberus-gate@inline": { options: { reviewerEffort: "inherit" } } },
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
 let first=true,review=0,prompts=0,tools=0;
 export const register=on=>{
  on('turn.step',async function*($,e,next){
   if(!e.agentId && first && ['revise','reload-review'].includes(${JSON.stringify(mode)})){
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
   if(${JSON.stringify(mode)}==='reload-review' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','review');await $.clock.sleep(7000);
   }
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
   if(e.tool==='Read' && !e.agentId && ${JSON.stringify(mode)}==='reload-work' && !(await $.fs.exists(${JSON.stringify(artifacts)}+'/reloaded'))){
    await $.fs.write(${JSON.stringify(artifacts)}+'/reload-ready','work');await $.clock.sleep(7000);
   }
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
      const modelScreen = tmux("capture-pane", "-p", "-t", session, "-S", "-200");
      await writeFile(join(artifacts, "model-picker.txt"), modelScreen);
      if (!modelScreen.includes("fable")) throw new Error("Fable model option did not appear");
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
      await pause(1000);
      const effortScreen = tmux("capture-pane", "-p", "-t", session, "-S", "-200");
      await writeFile(join(artifacts, "effort-picker.txt"), effortScreen);
      if (!effortScreen.includes("検査用 effort")) throw new Error("Effort picker did not open");
      tmux("send-keys", "-t", session, "Down", "Enter");
      const effortDeadline = Date.now() + 15_000;
      while (Date.now() < effortDeadline) {
        saved = JSON.parse(await readFile(settings, "utf8"));
        if (
          Object.values(saved.pluginConfigs ?? {}).some(
            (p) => p.options?.reviewerModel === "haiku" && p.options?.reviewerEffort === "low",
          )
        )
          break;
        await pause(250);
      }
      if (
        !Object.values(saved.pluginConfigs ?? {}).some(
          (p) => p.options?.reviewerModel === "haiku" && p.options?.reviewerEffort === "low",
        )
      )
        throw new Error("Model and effort selections were not persisted to user settings");
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
        (mode === "pass" ||
          mode === "model" ||
          mode === "search" ||
          mode === "revise" ||
          mode === "slow" ||
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
        slow: "検証済みの本文を公開しました。",
        timeout: "タイムアウト",
        "reload-work": "検証済みの本文を公開しました。",
        "reload-review": "検証済みの本文を公開しました。",
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
    if (mode.startsWith("reload-")) {
      if (!reloaded || !latest.includes("再ロード前の依頼と修正回数を復元しました。"))
        throw new Error("Reload recovery not observed");
      const restarted = latest.includes("再ロードで中断した回答の再生成・再審査を依頼します。");
      if (mode === "reload-work" && restarted)
        throw new Error("Work reload unnecessarily restarted a review");
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
    if (mode === "cancel" && !latest.includes("審査 #1: 開始"))
      throw new Error("Pending review log not observed");
    if (mode === "cancel" && /⏺\s+stable\b/u.test(latest))
      throw new Error("Cancelled answer published");
    if ((await readFile(join(work, "fact.txt"), "utf8")) !== "The release channel is stable.\n")
      throw new Error("Evidence modified");
    const records = await readdir(artifacts);
    const verdicts = [];
    const origins = [];
    let restartPrompts = 0;
    for (const name of records) {
      if (/^review-\d+\.json$/u.test(name)) {
        const review = JSON.parse(await readFile(join(artifacts, name), "utf8"));
        verdicts.push(review.result.text ?? "");
      }
      if (name.startsWith("prompt-")) {
        const prompt = JSON.parse(await readFile(join(artifacts, name), "utf8"));
        origins.push(prompt.origin);
        if (
          prompt.context?.some((text) =>
            text.includes("The answer review was interrupted by a plugin reload."),
          )
        )
          restartPrompts++;
      }
    }
    if (mode === "model" || mode === "pass") {
      const steps = [];
      const reviews = [];
      for (const name of records) {
        if (name.startsWith("step-"))
          steps.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
        if (/^review-\d+\.json$/u.test(name))
          reviews.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
      }
      if (!reviews.length) throw new Error("No real reviewer call observed");
      const main = steps.find((s) => !s.event.agentId);
      if (!main) throw new Error("No main answer step observed");
      for (const review of reviews) {
        if (review.request.model !== (mode === "model" ? "haiku" : main.event.model))
          throw new Error("Reviewer model did not match haiku");
        if (review.request.effort !== (mode === "model" ? "low" : main.event.effort))
          throw new Error("Reviewer effort did not match the configured or inherited effort");
      }
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
    const expectedPrompts =
      (mode === "revise" || mode === "reload-review" ? revisions : 0) + restartPrompts;
    if (
      restartPrompts > (mode === "reload-review" ? 1 : 0) ||
      (mode === "revise" && revisions < 1) ||
      pluginPrompts !== expectedPrompts
    )
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
    summary.push({ case: mode, status: "PASS", workspace: work, pluginPrompts, restartPrompts });
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
