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
    "Review final answers before publication using a read-only agent, and route corrections back to the main agent.",
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

const claude = (...args) =>
  execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

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
const manifest = await readJson(manifestPath, {
  name: marketplaceName,
  owner: { name: "HappyOnigiri", url: "https://github.com/HappyOnigiri" },
  metadata: { description: "Local marketplace for HappyOnigiri plugins." },
  plugins: [],
});
const names = new Set(entries.map((item) => item.name));
const others = (manifest.plugins ?? []).filter((item) => !names.has(item.name));
manifest.plugins = [...others, ...entries];
await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const marketplaces = JSON.parse(claude("plugin", "marketplace", "list", "--json"));
if (!marketplaces.some((item) => item.name === marketplaceName))
  claude("plugin", "marketplace", "add", marketplace);
claude("plugin", "marketplace", "update", marketplaceName);

// update は version が同じだと入れ替えないため、入れ直す。uninstall で /config の設定が
// 消えるので、先に読み取ってインストール後に戻す。
const settings = await readJson(join(config, "settings.json"), {});
const options = Object.fromEntries(
  Object.entries(settings?.pluginConfigs?.[plugin]?.options ?? {}).map(([key, value]) => [
    key,
    String(value),
  ]),
);
const saved = JSON.stringify(options);
if (saved !== "{}")
  console.error(
    `Saved options of ${plugin}. If a step below fails, set them again with:\n  echo '${saved}' | claude plugin configure --values-stdin ${plugin}`,
  );
const installed = JSON.parse(claude("plugin", "list", "--json"));
for (const item of entries) {
  const id = `${item.name}@${marketplaceName}`;
  if (installed.some((existing) => existing.id === id && existing.scope === "user"))
    claude("plugin", "uninstall", "--keep-data", "--scope", "user", id);
  claude("plugin", "install", "--scope", "user", id);
  if (id === plugin && saved !== "{}")
    execFileSync("claude", ["plugin", "configure", "--values-stdin", plugin], {
      input: saved,
      stdio: ["pipe", "inherit", "inherit"],
    });
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--", ...entries.map((item) => `plugins/${item.name}`))
  ? " + uncommitted changes"
  : "";
console.log(
  `Installed ${entries.map((item) => `${item.name}@${marketplaceName}`).join(", ")} from ${git("rev-parse", "--short", "HEAD")}${dirty}. Restart Claude Code to apply.`,
);
