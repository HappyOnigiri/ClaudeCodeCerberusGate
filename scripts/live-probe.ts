import { recordMetrics } from "./live-metrics.ts";
import { liveFixture } from "./live-fixture.ts";
import { verifyFork, verifyForkDiscard } from "./live-fork.ts";
import { customPrompt, facts, requests, expectedFindings } from "./live-scenarios.ts";
import { verifyQuestion } from "./live-question.ts";
import { verifyMenu, installMenuKeybindings } from "./live-menu.ts";
import { translate } from "../plugins/cerberus-gate/hooks/locale.ts";
import { language, t, verifyLanguage, historyMessage } from "./live-language.ts";
interface Settings {
  pluginConfigs?: Record<
    string,
    { options?: { reviewerModel?: string; reviewerEffort?: string; enabled?: boolean } }
  >;
}
import { verifyDebug } from "./live-debug.ts";
import { verifyMaterials } from "./live-materials.ts";
import { verifyRecovery } from "./live-recovery.ts";
import { installLiveFixture } from "./live-installed.ts";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const root = process.cwd();
const useFork = process.env.CERBERUS_REVIEW_METHOD === "fork";
const installedConfig = process.env.CERBERUS_INSTALLED_CONFIG;
if (
  installedConfig &&
  (!process.argv.slice(2).length ||
    process.argv.slice(2).some((mode) => !["pass", "revise"].includes(mode)))
)
  throw new Error("Installed verification supports pass and revise only");
const report = resolve(
  root,
  "tmp/live-probe",
  `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);
await mkdir(report, { recursive: true });
const allCases = [
  "question-pass",
  "question-revise",
  "question-context",
  "question-order",
  "question-editorial",
  "pass",
  "history",
  "model",
  "prompt",
  "bounds",
  "environment",
  "causal",
  "choice",
  "toggle",
  "search",
  "recover",
  "cli",
  "revise",
  "cap",
  "unverified",
  "missing-log",
  "cancel",
  "slow",
  "timeout",
  "reload-work",
  "reload-review",
];
const cases = process.argv.slice(2).length ? process.argv.slice(2) : allCases;
const tmux = (...args: string[]) =>
  execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Terminal wrapping and Markdown rendering consume whitespace, escape backslashes and code ticks.
const decisionOf = (text: string) => {
  try {
    return JSON.parse(text).decision;
  } catch {
    return undefined;
  }
};
const compact = (text: string) => text.replace(/[\s\\`*│]/gu, "");
const withoutFindings = (screen: string, findings: unknown[]) =>
  findings.reduce<string>(
    (text, finding) => text.replaceAll(compact(JSON.stringify(finding)), ""),
    compact(screen),
  );
let menuKeybindings = false;
const submit = async (session: string, text: string) => {
  tmux("send-keys", "-t", session, "-l", text);
  await pause(500);
  if (text === "/cgate") {
    tmux("send-keys", "-t", session, "Tab");
    await pause(100);
  }
  // ユーザーの Enter=改行設定にも対応する。通常設定では Enter を使う。
  tmux(
    "send-keys",
    "-t",
    session,
    "-l",
    process.env.CERBERUS_SUBMIT === "enter" && !menuKeybindings ? "\r" : "\x1b[13;5u",
  );
  await pause(500);
};
const summary = [];
for (const mode of cases) {
  menuKeybindings = mode === "model";
  if (!allCases.includes(mode)) throw new Error(`Unknown case ${mode}`);
  const needsRevision = ["history", "revise", "cap", "bounds", "environment", "causal"].includes(
    mode,
  );
  const work = await mkdtemp(join(tmpdir(), "cerberus-live-"));
  const artifacts = join(report, mode);
  const visibleFindings = [];
  const cliToken = randomBytes(18).toString("hex");
  const cliCommand = "git log -1 --format=%s";
  const cliExpected = JSON.stringify({ channel: "stable", token: cliToken });

  await mkdir(artifacts, { recursive: true });
  const plugin = join(work, "gate");
  await cp(join(root, "plugins/cerberus-gate"), plugin, {
    recursive: true,
    filter: (p) => !p.includes("/.claude-plugin/types"),
  });
  {
    const path = join(plugin, ".claude-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (mode === "cap" || mode.startsWith("question-"))
      manifest.userConfig.maxRevisions.default = mode === "cap" ? 1 : 4;
    manifest.userConfig.reviewerModel.default = useFork ? "inherit" : "haiku";
    await writeFile(path, JSON.stringify(manifest));
  }
  if (mode === "missing-log")
    await writeFile(join(plugin, "hooks/session-log.mts"), "process.exitCode=1;\n");
  const display = join(work, "display");
  await cp(join(root, "plugins/cerberus-gate-display"), display, {
    recursive: true,
    filter: (p) => !p.includes("/.claude-plugin/types"),
  });
  const configDir = installedConfig || join(work, "config");
  const settings = join(configDir, "settings.json");
  const reloadSettings = (maxRevisions: number) =>
    JSON.stringify({
      pluginConfigs: { "cerberus-gate@inline": { options: { maxRevisions, language } } },
    });
  if (
    !installedConfig &&
    (language === "ja" ||
      mode === "reload-work" ||
      mode === "model" ||
      mode === "toggle" ||
      mode === "prompt")
  ) {
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
      mode === "model" || mode === "toggle" || mode === "prompt"
        ? JSON.stringify({
            pluginConfigs: {
              "cerberus-gate@inline": {
                options: {
                  language,
                  reviewerEffort: "inherit",
                  ...(mode === "prompt" ? { reviewPrompt: customPrompt } : {}),
                },
              },
            },
          })
        : reloadSettings(2),
    );
  }
  if (!installedConfig && mode === "model") await installMenuKeybindings(configDir);
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
    liveFixture(mode, artifacts, useFork, cliCommand, work),
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
  if (mode === "history")
    await writeFile(
      join(work, "limits.ts"),
      "export const LIMIT = 7;\n" +
        Array.from(
          { length: 1200 },
          (_, i) => `// independent context row ${i}: ${"detail ".repeat(12)}`,
        ).join("\n") +
        "\n",
    );
  const factText = "The release channel is stable.\n" + (facts[mode] ? facts[mode] + "\n" : "");
  await writeFile(join(work, "fact.txt"), factText);
  if (mode === "cli") {
    execFileSync("git", ["init", "-q", work]);
    execFileSync("git", [
      "-C",
      work,
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      cliExpected,
    ]);
    await writeFile(
      join(artifacts, "cli-expected.json"),
      JSON.stringify({ command: cliCommand, output: cliExpected }),
    );
  }
  const cliHead =
    mode === "cli"
      ? execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" })
      : undefined;
  const removeInstalledFixture = installedConfig
    ? await installLiveFixture(configDir, work, mode)
    : undefined;
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
    ...(mode === "cli"
      ? ["Bash(git log:*)", "Bash(git -C " + (await realpath(work)) + " log:*)", "Bash(grep:*)"]
      : []),
    ...(installedConfig ? [] : ["--plugin-dir", plugin, "--plugin-dir", display]),
    ...(installedConfig ? [] : ["--plugin-dir", fixture]),
    ...(mode === "slow" ? ["--plugin-dir", delay] : []),
    "--setting-sources",
    installedConfig ||
    language === "ja" ||
    mode === "reload-work" ||
    mode === "model" ||
    mode === "toggle" ||
    mode === "prompt"
      ? "user,project,local"
      : "project,local",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--system-prompt",
    "Follow the user request. Use side-effect-free tools to inspect evidence.",
    "--debug-file",
    join(artifacts, "debug.log"),
  ];
  if (
    installedConfig ||
    language === "ja" ||
    mode === "reload-work" ||
    mode === "model" ||
    mode === "toggle" ||
    mode === "prompt"
  )
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
      "80",
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
      await verifyMenu(session, artifacts, settings, (text) => submit(session, text));
      await pause(1000);
      const modelScreen = tmux("capture-pane", "-p", "-t", session, "-S", "-200");
      await writeFile(join(artifacts, "model-picker.txt"), modelScreen);
      if (!modelScreen.includes("fable")) throw new Error("Fable model option did not appear");
      tmux("send-keys", "-t", session, "Down", "Enter");
      const savedDeadline = Date.now() + 15_000;
      let saved: Settings = {};
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
      if (!effortScreen.includes(t("effortPane"))) throw new Error("Effort picker did not open");
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
      const notice = translate(language, "effortSaved", "low");
      const before = tmux("capture-pane", "-p", "-t", session);
      await writeFile(join(artifacts, "notice-before.txt"), before);
      if (!before.includes(notice)) throw new Error("Temporary notice was not displayed");
      await pause(3500);
      const after = tmux("capture-pane", "-p", "-t", session);
      await writeFile(join(artifacts, "notice-after.txt"), after);
      if (after.includes(notice)) throw new Error("Temporary notice did not expire");
    }
    if (mode === "toggle") {
      const checkCommand = async (command: string, expected: string, scope?: string) => {
        const before = tmux("capture-pane", "-p", "-t", session, "-S", "-1000").split(
          expected,
        ).length;
        await submit(session, command);
        if (scope) {
          const pickerDeadline = Date.now() + 10_000;
          while (!tmux("capture-pane", "-p", "-t", session).includes(t("sessionScope"))) {
            if (Date.now() > pickerDeadline) throw new Error("Scope picker did not open");
            await pause(250);
          }
          await writeFile(
            join(artifacts, `scope-${scope}.txt`),
            tmux("capture-pane", "-p", "-t", session),
          );
          if (scope === "saved") tmux("send-keys", "-t", session, "Down");
          tmux("send-keys", "-t", session, "Enter");
        }
        const until = Date.now() + 15_000;
        while (Date.now() < until) {
          const screen = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
          if (screen.split(expected).length > before) {
            await writeFile(join(artifacts, command.replaceAll(/[^a-z]/gu, "-") + ".txt"), screen);
            return;
          }
          await pause(250);
        }
        throw new Error(`Command failed: ${command}`);
      };
      await checkCommand("/cgate off", "off (saved)", "saved");
      await pause(1500);
      const saved: Settings = JSON.parse(await readFile(settings, "utf8"));
      if (!Object.values(saved.pluginConfigs ?? {}).some((p) => p.options?.enabled === false))
        throw new Error("Disabled setting was not persisted");
      await submit(session, "Reply with exactly DISABLED_OK.");
      const until = Date.now() + 30_000;
      while (!tmux("capture-pane", "-p", "-t", session, "-S", "-1000").includes("⏺ DISABLED_OK")) {
        if (Date.now() > until) throw new Error("Disabled answer not shown");
        await pause(250);
      }
      if ((await readdir(artifacts)).some((name) => /^review-/u.test(name)))
        throw new Error("Review ran while disabled");
      await checkCommand("/cgate on", "on (session)", "session");
      const unchanged = JSON.parse(await readFile(settings, "utf8"));
      if (JSON.stringify(unchanged) !== JSON.stringify(saved))
        throw new Error("Session override changed settings");
      await checkCommand("/cgate reset", "off (saved)");
      await checkCommand("/cgate on", "on (saved)", "saved");
      await pause(1500);
      const enabled: Settings = JSON.parse(await readFile(settings, "utf8"));
      if (!Object.values(enabled.pluginConfigs ?? {}).some((p) => p.options?.enabled === true))
        throw new Error("Enabled setting was not persisted");
    }
    if (mode === "history") {
      await submit(
        session,
        `For all later answers include the token ORCHID. Use the Read tool on ${join(work, "limits.ts")} with limit 600 now; its LIMIT definition is authoritative. Acknowledge with ORCHID ACK.`,
      );
      const until = Date.now() + 90_000;
      while (
        !(await readdir(artifacts)).some((entry) => entry.startsWith("complete-")) ||
        !tmux("capture-pane", "-p", "-t", session, "-S", "-1000").includes("done")
      ) {
        if (Date.now() > until) throw new Error("Historical turn did not complete");
        await pause(250);
      }
    }
    await submit(
      session,
      mode === "history"
        ? "Correction: report the numeric upper limit instead of the release channel. Keep earlier requirements. Reply in one line."
        : mode === "cli"
          ? "Run git log -1 --format=%s and reply with exactly that JSON release record, including its evidence token. No other text."
          : requests[mode]
            ? "Read fact.txt. Start your answer with the release channel in lowercase plain text, then: " +
              requests[mode]
            : "Read fact.txt and reply with exactly the release channel, with no other text.",
    );
    let reloaded = false;
    let cancelled = false;
    let passed = false;
    let latest = "";
    let reviewingSince;
    let persistentReview = false;
    let completedAt;
    while (Date.now() < deadline) {
      latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      await writeFile(join(artifacts, "screen.txt"), latest);
      if (
        mode.startsWith("question-") &&
        (await readdir(artifacts)).includes("question-dispatched.json") &&
        latest.includes("Enter to select")
      ) {
        passed = true;
        break;
      }
      if (mode === "slow" && latest.includes(t("waiting"))) {
        reviewingSince ??= Date.now();
        if (Date.now() - reviewingSince > 3500) {
          persistentReview = true;
          await writeFile(join(artifacts, "persistent-review.txt"), latest);
        }
      }
      if (!reloaded && (await readdir(artifacts)).includes("reload-ready")) {
        await writeFile(join(artifacts, "reloaded"), "yes");
        if (mode === "reload-work") await writeFile(settings, reloadSettings(3));
        else {
          const module = join(plugin, "hooks/register.ts");
          await writeFile(module, (await readFile(module, "utf8")) + "\n// live reload probe\n");
        }
        reloaded = true;
      }
      if (
        reloaded &&
        mode === "reload-work" &&
        latest.includes("options changed") &&
        latest.includes("reloaded")
      )
        await writeFile(join(artifacts, "reload-confirmed"), "yes");
      if (latest.includes("CERBERUS_REJECTED_DRAFT") || latest.includes("INVALID_REVIEW"))
        throw new Error("Private draft or verdict leaked to the TUI");
      if (/\berror\b|hook skipped|hook failed|hooks module did not load/iu.test(latest))
        throw new Error("Hook error in TUI");
      if (mode === "cancel" && !cancelled && latest.includes(t("waiting"))) {
        await submit(session, "/cgate history");
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
        (mode === "unverified" || mode === "missing-log" || mode === "timeout") &&
        // The notice is a log row of its own; the answer row starts with the held body.
        latest.includes(t("unverified")) &&
        /⏺\s+stable\b/u.test(latest)
      ) {
        passed = true;
        break;
      }
      if (
        (mode === "history" ||
          mode === "pass" ||
          mode === "prompt" ||
          mode === "choice" ||
          mode === "toggle" ||
          mode === "model" ||
          mode === "search" ||
          mode === "recover" ||
          mode === "cli" ||
          needsRevision ||
          mode === "slow" ||
          mode.startsWith("reload-")) &&
        (mode === "history"
          ? latest
              .split("\n")
              .some((line) => /⏺/u.test(line) && line.includes("ORCHID") && /\b7\b/u.test(line))
          : mode === "cli"
            ? latest.includes(cliToken) && /⏺\s*\{/u.test(latest)
            : (mode === "cap"
                ? latest.includes(t("unverified")) && latest.includes("stable")
                : /⏺\s+stable\b/u.test(latest)) &&
              (mode !== "cap" || latest.includes(t("unverified"))) &&
              (mode !== "pass" || latest.includes("⏺ cerberus-gate: Cerberus Gate: [PASS]")))
      ) {
        // A reload may queue another continuation after an earlier stable answer.
        // Observe an idle terminal before collecting the final control-prompt ledger.
        if (mode !== "reload-review" || latest.includes("? for shortcuts")) {
          completedAt ??= Date.now();
          if (mode !== "reload-review" || Date.now() - completedAt >= 1500) {
            passed = true;
            break;
          }
        } else completedAt = undefined;
      }
      await pause(500);
    }
    if (!passed) throw new Error("Expected completion not observed before deadline");
    if (useFork) {
      await pause(mode === "timeout" ? 8500 : 500);
      await verifyFork(artifacts, mode, latest);
      await submit(session, "/cgate log");
      const debugReport = await verifyDebug(work, artifacts, installedConfig);
      await verifyForkDiscard(debugReport, mode);
      summary.push({ case: mode, method: "fork", status: "PASS", workspace: work });
      console.log(`PASS fork ${mode}`);
      continue;
    }
    if (mode.startsWith("question-")) {
      await verifyQuestion(artifacts, mode, latest);
      summary.push({ case: mode, language, status: "PASS", workspace: work });
      console.log(`PASS ${mode}`);
      continue;
    }
    if (needsRevision && latest.includes(t("waiting")))
      throw new Error("Waiting notice remained in the completed answer");
    const completedDebug = await verifyDebug(work, artifacts, installedConfig);
    // The history gate can replace an intermediate REVISE; only settled verdicts are delivered.
    const acceptedVerdicts = completedDebug.flatMap((entry) =>
      entry.instances.flatMap((instance) => instance.verdicts),
    );
    for (const verdict of acceptedVerdicts)
      if (verdict.decision === "REVISE") visibleFindings.push(...verdict.findings);
    if ((needsRevision && mode !== "history") || mode === "reload-review") {
      if (expectedFindings[mode] && !visibleFindings.some((f) => expectedFindings[mode]!.test(f)))
        throw new Error("Reviewer did not identify the intended material evidence problem");
      const heading = "Prompt from the cerberus-gate plugin";
      const body = t("control");
      const findingsHeading = t("findings").trim();
      if (!latest.includes(heading) || latest.includes(body) || latest.includes(findingsHeading))
        throw new Error("Control prompt was not collapsed to its sender heading");
      await writeFile(join(artifacts, "collapsed-screen.txt"), latest);
      tmux("send-keys", "-t", session, "C-o");
      const expandedDeadline = Date.now() + 10_000;
      while (Date.now() < expandedDeadline) {
        latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
        if (latest.includes(heading) && latest.includes(body)) break;
        await pause(250);
      }
      await writeFile(join(artifacts, "expanded-screen.txt"), latest);
      if (!latest.includes(body)) throw new Error("Ctrl+O did not expand the control prompt");
      if (!latest.includes(findingsHeading))
        throw new Error("Expanded control prompt did not show reviewer findings");
      for (const finding of visibleFindings)
        if (!compact(latest).includes(compact(JSON.stringify(finding))))
          throw new Error("Expanded control prompt omitted a reviewer finding");
      if (withoutFindings(latest, visibleFindings).includes("CERBERUS_REJECTED_DRAFT"))
        throw new Error("Private draft leaked through the detailed transcript");
      tmux("send-keys", "-t", session, "C-o");
      const collapsedDeadline = Date.now() + 10_000;
      while (Date.now() < collapsedDeadline) {
        // Redraws can leave the former expanded frame in tmux scrollback.
        // Check the current viewport when verifying that the control collapsed.
        latest = tmux("capture-pane", "-p", "-t", session);
        if (latest.includes(heading) && !latest.includes(body)) break;
        await pause(250);
      }
      await writeFile(join(artifacts, "recollapsed-screen.txt"), latest);
      if (!latest.includes(heading) || latest.includes(body) || latest.includes(findingsHeading))
        throw new Error("Ctrl+O did not collapse the control prompt again");
      if (latest.includes("CERBERUS_REJECTED_DRAFT"))
        throw new Error("Private draft leaked after toggling the detailed transcript");
    }
    await submit(session, "/cgate history");
    const logDeadline = Date.now() + 15_000;
    let logSeen = false;
    while (Date.now() < logDeadline) {
      latest = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      const expected = historyMessage(mode);
      if (latest.includes(t("logHeader")) && latest.includes(expected ?? "")) {
        logSeen = true;
        break;
      }
      await pause(250);
    }
    await writeFile(join(artifacts, "log-screen.txt"), latest);
    if (!logSeen) throw new Error("Expected session log not observed");
    if (needsRevision && !latest.includes(t("findings").trim()))
      throw new Error("Session log did not show reviewer findings");
    if (needsRevision)
      for (const finding of visibleFindings)
        if (!compact(latest).includes(compact(JSON.stringify(finding))))
          throw new Error("Session log omitted a reviewer finding");
    if (mode.startsWith("reload-")) {
      if (!reloaded || !latest.includes(t("restored")))
        throw new Error("Reload recovery not observed");
      const restarted = latest.includes(t("restarting"));
      if (mode === "reload-work" && restarted)
        throw new Error("Work reload unnecessarily restarted a review");
    }
    if (!/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/u.test(latest))
      throw new Error("UTC timestamp not observed in session log");
    if (
      withoutFindings(latest, visibleFindings).includes("CERBERUS_REJECTED_DRAFT") ||
      latest.includes("INVALID_REVIEW")
    )
      throw new Error("Private draft or verdict leaked through session log");
    if (mode === "pass") {
      // 末尾の空白でコマンド候補のメニューを閉じてから送信する。
      await submit(session, "/clear ");
      const clearDeadline = Date.now() + 10_000;
      while (!(await readdir(artifacts)).includes("session-end.json")) {
        if (Date.now() >= clearDeadline) throw new Error("/clear did not end the session");
        await pause(250);
      }
      await submit(session, "/cgate history");
      const screen = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      await writeFile(join(artifacts, "clear-screen.txt"), screen);
      if (!screen.includes(t("noLogs"))) throw new Error("Session log survived /clear");
    }
    if (mode === "cancel" && !latest.includes(translate(language, "reviewStarted", 1)))
      throw new Error("Pending review log not observed");
    if (mode === "cancel" && /⏺\s+stable\b/u.test(latest))
      throw new Error("Cancelled answer published");
    if ((await readFile(join(work, "fact.txt"), "utf8")) !== factText)
      throw new Error("Evidence modified");
    const records = await readdir(artifacts);
    const verdicts = [];
    const origins = [];
    let restartPrompts = 0;
    for (const name of records) {
      if (/^review-\d+\.json$/u.test(name)) {
        const review = JSON.parse(await readFile(join(artifacts, name), "utf8"));
        verdicts.push(review.result.text ?? "");
        verifyLanguage(review.request);
      }
      if (name.startsWith("prompt-")) {
        const prompt = JSON.parse(await readFile(join(artifacts, name), "utf8"));
        origins.push(prompt.origin);
        // This fixture observes submissions before the gate attaches hidden context.
        // Restart controls have no findings; correction controls always include them.
        if (
          prompt.origin.kind === "plugin" &&
          prompt.origin.name === "cerberus-gate" &&
          prompt.text.startsWith(t("control") + " [") &&
          !prompt.text.includes("\n")
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
        if (review.request.model !== "haiku") throw new Error("Reviewer model did not match haiku");
        if (review.request.effort !== (mode === "model" ? "low" : main.event.effort))
          throw new Error("Reviewer effort did not match the configured or inherited effort");
      }
    }
    if (mode === "prompt") {
      const reviews = await Promise.all(
        records
          .filter((n) => /^review-\d+\.json$/u.test(n))
          .map(async (n) => JSON.parse(await readFile(join(artifacts, n), "utf8"))),
      );
      if (!reviews.length || reviews.some((r) => !r.request.system.startsWith(customPrompt)))
        throw new Error("Saved multiline review prompt did not reach the model");
      if (
        !reviews.some(
          (r) =>
            r.result.text.includes('"tool":"Read"') || /"tool"\s*:\s*"Read"/u.test(r.result.text),
        )
      )
        throw new Error("Custom criteria did not produce a real Read request");
    }
    if (mode === "choice" && verdicts.some((v) => v.includes('"REVISE"')))
      throw new Error("An unresolved specification proposal was incorrectly rejected");
    await verifyMaterials(records, artifacts, mode);
    const pluginPrompts = origins.filter(
      (origin) => origin.kind === "plugin" && origin.name === "cerberus-gate",
    ).length;
    if (needsRevision && !verdicts.some((v) => v.includes('"REVISE"')))
      throw new Error("No real reviewer REVISE verdict observed");
    const revisions = acceptedVerdicts.filter((verdict) => verdict.decision === "REVISE").length;
    const expectedPrompts =
      (needsRevision || mode === "reload-review"
        ? Math.min(revisions, mode === "cap" ? 1 : 2)
        : 0) + restartPrompts;
    if (
      restartPrompts > (mode === "reload-review" ? 1 : 0) ||
      (needsRevision && revisions < 1) ||
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
    if (mode === "recover") await verifyRecovery(records, artifacts);
    if (mode === "cli") {
      const reviews = [];
      const calls = [];
      for (const name of records) {
        if (/^review-\d+\.json$/u.test(name))
          reviews.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
        if (name.startsWith("tool-"))
          calls.push(JSON.parse(await readFile(join(artifacts, name), "utf8")));
      }
      const requested = reviews.some((review) => {
        try {
          const call = JSON.parse(review.result.text);
          return call.tool === "Bash" && call.input.command === cliCommand;
        } catch {
          return false;
        }
      });
      const executed = calls.some(
        (call) =>
          call.tool === "Bash" &&
          call.input.command === cliCommand &&
          call.origin.plugin === "cerberus-gate" &&
          call.result.deny === undefined &&
          !call.result.isError &&
          JSON.stringify(call.result).includes(cliToken),
      );
      const used = reviews.some((review) => {
        const input = JSON.parse(review.request.prompt.split("\nBefore deciding,")[0]);
        try {
          return (
            decisionOf(review.result.text) === "PASS" &&
            JSON.stringify(JSON.parse(input.unpublishedDraft)) === cliExpected &&
            input.evidence.some(
              (entry: { tool: string; input: { command?: string }; result: string }) =>
                entry.tool === "Bash" &&
                entry.input.command === cliCommand &&
                entry.result.includes(cliExpected),
            )
          );
        } catch {
          return false;
        }
      });
      if (!requested || !executed || !used)
        throw new Error(
          "Reviewer CLI request, execution, output and evidence-based PASS were not all observed",
        );
      if (
        execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }) !== cliHead ||
        execFileSync("git", ["-C", work, "log", "-1", "--format=%s"], {
          encoding: "utf8",
        }).trim() !== cliExpected
      )
        throw new Error("CLI evidence modified");
    }
    if (mode === "slow") {
      if (!persistentReview) throw new Error("Review status did not persist beyond three seconds");
      const start = JSON.parse(await readFile(join(artifacts, "review-start-1.json"), "utf8"));
      const end = JSON.parse(await readFile(join(artifacts, "review-1.json"), "utf8"));
      if (end.at - start.at < 10000) throw new Error("Slow review did not exceed ten seconds");
    }
    const debugReport = completedDebug;
    await submit(session, "/cgate log");
    let debugScreen = "";
    const debugDeadline = Date.now() + 15_000;
    while (Date.now() < debugDeadline) {
      debugScreen = tmux("capture-pane", "-p", "-t", session, "-S", "-1000");
      if (
        debugReport.some((entry) =>
          compact(debugScreen).includes(compact(entry.directory + "/index.jsonl")),
        )
      )
        break;
      await pause(250);
    }
    await writeFile(join(artifacts, "debug-location-screen.txt"), debugScreen);
    if (
      !debugScreen.includes(t("saved")) ||
      !debugReport.some((entry) =>
        compact(debugScreen).includes(compact(entry.directory + "/index.jsonl")),
      )
    )
      throw new Error("Debug command did not display persisted absolute paths");
    summary.push({
      case: mode,
      language,
      status: "PASS",
      workspace: work,
      pluginPrompts,
      restartPrompts,
    });
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
    await recordMetrics(artifacts, useFork ? "fork" : "complete");
    if (started) tmux("kill-session", "-t", session);
    removeInstalledFixture?.();
  }
}
await writeFile(
  join(report, "report.json"),
  JSON.stringify(
    {
      claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
      model: "haiku",
      installed: Boolean(installedConfig),
      cases: summary,
    },
    null,
    2,
  ),
);
console.log(`Report: ${report}`);
