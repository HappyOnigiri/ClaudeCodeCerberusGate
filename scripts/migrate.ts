import type { Settings } from "./migration-settings.ts";
interface InstalledPlugin {
  id: string;
  scope: string;
  enabled: boolean;
  projectPath?: string;
}
interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  path: string;
  url?: string;
}
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readSettings, patchSettings } from "./migration-settings.ts";

const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const path = join(config, "settings.json");
const oldIds = [
  "cerberus-gate@happyonigiri-plugins",
  "cerberus-gate-display@happyonigiri-plugins",
] as const;
const newIds = ["cerberus-gate@cerberus-gate", "cerberus-gate-display@cerberus-gate"] as const;
const ids = [...oldIds, ...newIds];
const cli = (...args: string[]) => {
  try {
    return execFileSync("claude", ["plugin", ...args], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // CLI output may contain user configuration. Report the operation, never its output.
    throw new Error(`Claude CLI failed: plugin ${args.join(" ")}`);
  }
};
const list = (): InstalledPlugin[] => JSON.parse(cli("list", "--json"));
const user = (items: InstalledPlugin[], id: string) =>
  items.find((item) => item.id === id && item.scope === "user");
const enabled = (settings: Settings, items: InstalledPlugin[], id: string) =>
  settings.enabledPlugins?.[id] ?? user(items, id)?.enabled ?? false;
const setEnabled = (id: string, value: boolean) => {
  if (user(list(), id)?.enabled !== value) cli(value ? "enable" : "disable", "--scope", "user", id);
};

async function rollback(
  before: Settings,
  installed: InstalledPlugin[],
  changedOptions: string[],
  options: Record<string, unknown>,
) {
  const failures = [];
  // Disable the new pair before restoring the legacy pair, including partial CLI failures.
  for (const id of newIds) {
    try {
      if (user(list(), id)) setEnabled(id, false);
    } catch {
      failures.push(id);
    }
  }
  try {
    await patchSettings(path, (current) => {
      current.enabledPlugins ??= {};
      for (const id of ids) {
        if (Object.hasOwn(before.enabledPlugins ?? {}, id))
          current.enabledPlugins[id] = before.enabledPlugins![id]!;
        else if (newIds.some((newId) => newId === id) && !user(installed, id))
          current.enabledPlugins[id] = false;
        else delete current.enabledPlugins[id];
      }
      const savedOptions = current.pluginConfigs?.[newIds[0]]?.options;
      for (const key of changedOptions)
        if (savedOptions && isDeepStrictEqual(savedOptions[key], options[key]))
          delete savedOptions[key];
    });
  } catch {
    failures.push("settings.json");
  }
  return failures;
}

function marketplaceSource() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--marketplace-source"))
    throw new Error("Usage: npm run migrate -- [--marketplace-source <source>]");
  return args[1] ?? "HappyOnigiri/ClaudeCodeCerberusGate";
}

async function migrate() {
  const source = marketplaceSource();
  console.log("Close interactive Claude Code sessions before migration. Restart after completion.");
  const before = await readSettings(path);
  const installed = list();
  const elsewhere = installed.filter(
    (item) => ids.some((id) => id === item.id) && item.scope !== "user",
  );
  if (elsewhere.length)
    throw new Error(
      `Migrate only user scope. Disable or migrate these installations separately: ${elsewhere.map((item) => `${item.id} (${item.scope}: ${item.projectPath ?? "managed"})`).join(", ")}`,
    );
  const markets: Marketplace[] = JSON.parse(cli("marketplace", "list", "--json"));
  const market = markets.find((item) => item.name === "cerberus-gate");
  if (market) {
    const matches =
      source === "HappyOnigiri/ClaudeCodeCerberusGate"
        ? market.source === "github" && market.repo === source
        : (market.source === "directory" && resolve(market.path) === resolve(source)) ||
          (market.source === "git" && market.url === source);
    if (!matches)
      throw new Error("Marketplace cerberus-gate has a different source; no changes made.");
  }
  const legacy = before.pluginConfigs?.[oldIds[0]]?.options ?? {};
  const options = Object.fromEntries(
    Object.entries(legacy).filter(([key]) => key !== "readOnlyMcpTools"),
  );
  const existing = before.pluginConfigs?.[newIds[0]]?.options ?? {};
  const conflicts = Object.keys(options).filter(
    (key) => Object.hasOwn(existing, key) && !isDeepStrictEqual(existing[key], options[key]),
  );
  if (conflicts.length) throw new Error(`Conflicting option keys: ${conflicts.join(", ")}`);
  const additions = Object.keys(options).filter((key) => !Object.hasOwn(existing, key));
  const oldActive = enabled(before, installed, oldIds[0]);
  if (oldActive && enabled(before, installed, newIds[0]))
    throw new Error(
      `Both reviewer IDs are enabled. Disable ${newIds[0]} with claude plugin disable --scope user <id>, then rerun npm run migrate.`,
    );
  const alreadyMigrated =
    oldIds.every((id) => !enabled(before, installed, id)) &&
    newIds.every((id) => user(installed, id)) &&
    additions.length === 0;
  if (alreadyMigrated) {
    console.log("Already migrated. Restart Claude Code to apply.");
    return;
  }
  const targetActive = user(installed, oldIds[0])
    ? oldActive
    : enabled(before, installed, newIds[0]);
  const changedOptions: string[] = [];
  try {
    // Installation enables plugins by default. Explicitly gate the new IDs first.
    await patchSettings(path, (current) => {
      current.enabledPlugins ??= {};
      for (const id of newIds) current.enabledPlugins[id] = false;
    });
    if (!market) cli("marketplace", "add", source);
    if (newIds.some((id) => !user(installed, id))) cli("install", "--scope", "user", newIds[0]);
    const afterInstall = list();
    for (const id of newIds)
      if (!user(afterInstall, id)) throw new Error(`Dependency installation not verified: ${id}`);
    // Keep the new pair disabled until options have been verified and the old pair disabled.
    for (const id of newIds) setEnabled(id, false);
    await patchSettings(path, (current) => {
      current.pluginConfigs ??= {};
      const entry = (current.pluginConfigs[newIds[0]] ??= {});
      entry.options ??= {};
      for (const key of additions) {
        if (
          Object.hasOwn(entry.options, key) &&
          !isDeepStrictEqual(entry.options[key], options[key])
        )
          throw new Error(`Conflicting option key: ${key}`);
        entry.options[key] = options[key];
        changedOptions.push(key);
      }
    });
    const saved = await readSettings(path);
    for (const key of Object.keys(options))
      if (!isDeepStrictEqual(saved.pluginConfigs?.[newIds[0]]?.options?.[key], options[key]))
        throw new Error(`Option not saved: ${key}`);
    for (const id of oldIds) if (user(installed, id)) setEnabled(id, false);
    for (const id of newIds) setEnabled(id, targetActive);
    const final = await readSettings(path);
    const finalList = list();
    if (
      oldIds.some((id) => enabled(final, finalList, id)) ||
      newIds.some((id) => !user(finalList, id) || enabled(final, finalList, id) !== targetActive)
    )
      throw new Error("Final enabled state verification failed");
    console.log(
      "Migration complete; legacy settings and shared marketplace retained. Restart Claude Code.",
    );
  } catch (error) {
    const failures = await rollback(before, installed, changedOptions, options);
    if (failures.length)
      throw new Error(
        `Migration failed; rollback incomplete (${failures.join(", ")}). Close sessions, disable ${newIds.join(" and ")} with claude plugin disable --scope user <id>, inspect settings.json, then rerun npm run migrate.`,
        { cause: error },
      );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Previous settings restored; newly installed plugins remain disabled. Rerun npm run migrate after resolving the failure.`,
      { cause: error },
    );
  }
}
try {
  await migrate();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
