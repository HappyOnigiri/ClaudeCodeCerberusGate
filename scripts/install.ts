// make install の本体。作業ツリーの審査・描画プラグインを、未コミットの変更も含めて
// ローカル marketplace happyonigiri-plugins 経由で Claude Code にインストールする。
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const marketplace = join(config, "local-marketplaces/happyonigiri");
const marketplaceName = "happyonigiri-plugins";
const plugin = `cerberus-gate@${marketplaceName}`;
const entry = {
  name: "cerberus-gate",
  displayName: "Cerberus Gate",
  description:
    "Review final answers before publication using session tools under instructions prohibiting side effects, and route corrections back to the main agent.",
  source: "./cerberus-gate",
  homepage: "https://github.com/HappyOnigiri/ClaudeCodeCerberusGate",
  keywords: ["review", "agents", "mod"],
};
const entries = [
  entry,
  {
    name: "cerberus-gate-display",
    displayName: "Cerberus Gate Display",
    description: "Collapse Cerberus Gate control prompts; expand their body with Ctrl+O.",
    source: "./cerberus-gate-display",
    homepage: entry.homepage,
    keywords: ["review", "display", "mod"],
  },
];

const claude = (...args: string[]) =>
  execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Refuse before touching the shared marketplace or installed plugins.
const initialSettings = await readJson<{ enabledPlugins?: Record<string, boolean> }>(
  join(config, "settings.json"),
  {},
);
const initialPlugins: { id: string; enabled: boolean }[] = JSON.parse(
  claude("plugin", "list", "--json"),
);
if (
  entries.some((item) => {
    const id = `${item.name}@cerberus-gate`;
    return (
      initialSettings.enabledPlugins?.[id] === true ||
      initialPlugins.some((installed) => installed.id === id && installed.enabled)
    );
  })
) {
  console.error(
    "Public Cerberus Gate is enabled. Use --plugin-dir for development instead of make install.",
  );
  process.exit(1);
}

// 実行時に読むファイルだけを置く。テストと生成された型定義は配布しない。
for (const item of entries) {
  const source = resolve(root, "plugins", item.name);
  const target = join(marketplace, item.name);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const name = relative(source, path);
      return !/^(?:tests|tsconfig\.json|\.claude-plugin\/types)(?:\/|$)/u.test(name);
    },
  });
}

// marketplace.json は watchdog など他のプラグインと共有するため、対象の2項目だけを差し替える。
const manifestPath = join(marketplace, ".claude-plugin/marketplace.json");
const manifest = await readJson<{
  name: string;
  owner: { name: string; url: string };
  metadata: { description: string };
  plugins: { name: string }[];
}>(manifestPath, {
  name: marketplaceName,
  owner: { name: "HappyOnigiri", url: "https://github.com/HappyOnigiri" },
  metadata: { description: "Local marketplace for HappyOnigiri plugins." },
  plugins: [],
});
const names = new Set(entries.map((item) => item.name));
const others = (manifest.plugins ?? []).filter((item: { name: string }) => !names.has(item.name));
manifest.plugins = [...others, ...entries];
await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const marketplaces = JSON.parse(claude("plugin", "marketplace", "list", "--json"));
if (!marketplaces.some((item: { name: string }) => item.name === marketplaceName))
  claude("plugin", "marketplace", "add", marketplace);
claude("plugin", "marketplace", "update", marketplaceName);

// update は version が同じだと入れ替えないため、入れ直す。uninstall で /config の設定が
// 消えるので、先に読み取ってインストール後に戻す。
const settingsPath = join(config, "settings.json");
const settings = await readJson<{
  pluginConfigs?: Record<string, { options?: Record<string, unknown> }>;
}>(settingsPath, {});
const options = Object.fromEntries(
  Object.entries(settings?.pluginConfigs?.[plugin]?.options ?? {}).filter(
    ([key]) => key !== "readOnlyMcpTools",
  ),
);
if (Object.keys(options).length)
  console.error(`Preserving saved options of ${plugin} across reinstallation.`);
const installed = JSON.parse(claude("plugin", "list", "--json"));
for (const item of entries) {
  const id = `${item.name}@${marketplaceName}`;
  if (
    installed.some(
      (existing: { id: string; scope: string }) => existing.id === id && existing.scope === "user",
    )
  )
    claude("plugin", "uninstall", "--keep-data", "--scope", "user", id);
  claude("plugin", "install", "--scope", "user", id);
}

// The configure CLI only accepts single-line strings. Restore native values, including
// multiline review criteria, while retaining settings written by the installation.
if (Object.keys(options).length) {
  const current = JSON.parse(await readFile(settingsPath, "utf8"));
  current.pluginConfigs ??= {};
  const pluginSettings = (current.pluginConfigs[plugin] ??= {});
  pluginSettings.options = { ...pluginSettings.options, ...options };
  await writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ...entries.map((item) => `plugins/${item.name}`))
  ? " + uncommitted changes"
  : "";
console.log(
  `Installed ${entries.map((item) => `${item.name}@${marketplaceName}`).join(", ")} from ${git("rev-parse", "--short", "HEAD")}${dirty}. Restart Claude Code to apply.`,
);
