// Real CLI distribution checks; every mutation is confined to a disposable config and Git repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const work = await mkdtemp(join(tmpdir(), "cerberus-distribution-"));
const repo = join(work, "repo");
const config = join(work, "config");
const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
const run = (command: string, args: string[], cwd = root) =>
  execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
const cli = (...args: string[]) => run("claude", ["plugin", ...args]);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, data: unknown) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
await mkdir(repo);
await mkdir(config);
await cp(resolve("plugins"), join(repo, "plugins"), {
  recursive: true,
  filter: (p) => !p.includes("/.claude-plugin/types"),
});
await cp(resolve(".claude-plugin"), join(repo, ".claude-plugin"), { recursive: true });
run("git", ["init", "-q", repo]);
const commit = (message: string) => {
  run("git", ["add", "."], repo);
  run(
    "git",
    [
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      message,
    ],
    repo,
  );
};
commit("Initial marketplace");
const source = repo;
cli("marketplace", "add", source);
cli("install", "--scope", "user", "cerberus-gate@cerberus-gate");
let installed: { id: string; scope: string; enabled: boolean; version: string }[] = JSON.parse(
  cli("list", "--json"),
);
assert.equal(installed.length, 2);
assert.ok(installed.every((i) => i.scope === "user" && i.enabled));
console.log("PASS dependency auto-install from local Git directory");
// Reset only this disposable config's public installation before testing the old installer.
for (const id of ["cerberus-gate@cerberus-gate", "cerberus-gate-display@cerberus-gate"])
  cli("uninstall", "--scope", "user", "--keep-data", id);
run(process.execPath, [resolve("scripts/install.ts")]);
const old = "cerberus-gate@happyonigiri-plugins";
const fresh = "cerberus-gate@cerberus-gate";
const settingsPath = join(config, "settings.json");
const options = {
  reviewerModel: "haiku",
  maxRevisions: 3,
  enabled: true,
  reviewPrompt: "Check the evidence.\nCheck the conclusions.",
};
let settings = await json(settingsPath);
settings.pluginConfigs ??= {};
settings.pluginConfigs[old] = { options: { ...options, readOnlyMcpTools: "retired" } };
settings.unrelated = { keep: "unchanged" };
await save(settingsPath, settings);
const migrate = () =>
  run(process.execPath, [resolve("scripts/migrate.ts"), "--marketplace-source", source]);
migrate();
settings = await json(settingsPath);
assert.deepEqual(settings.pluginConfigs[fresh].options, options);
assert.deepEqual(settings.unrelated, { keep: "unchanged" });
for (const id of [old, old.replace("cerberus-gate@", "cerberus-gate-display@")])
  assert.equal(settings.enabledPlugins[id], false);
for (const id of [fresh, fresh.replace("cerberus-gate@", "cerberus-gate-display@")])
  assert.equal(settings.enabledPlugins[id], true);
migrate();
assert.deepEqual(await json(settingsPath), settings);
console.log("PASS real migration and rerun");
const manifestPath = join(repo, "plugins/cerberus-gate/.claude-plugin/plugin.json");
const manifest = await json(manifestPath);
manifest.version = "0.1.2";
await save(manifestPath, manifest);
commit("Probe update");
cli("marketplace", "update", "cerberus-gate");
cli("update", "--scope", "user", fresh);
installed = JSON.parse(cli("list", "--json"));
assert.equal(installed.find((i) => i.id === fresh)?.version, "0.1.2");
assert.deepEqual((await json(settingsPath)).pluginConfigs[fresh].options, options);
console.log("PASS local marketplace update preserves typed options");
// Use defaults for the subsequent interactive verification, keeping the update check independent.
settings = await json(settingsPath);
delete settings.pluginConfigs[fresh];
await save(settingsPath, settings);
await mkdir(resolve("tmp"), { recursive: true });
await save(resolve("tmp/distribution-report.json"), { work, config, source, status: "PASS" });
console.log(`Report: ${resolve("tmp/distribution-report.json")}`);
