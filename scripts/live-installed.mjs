import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Installed fixtures must follow the installed gate in hook registration order.
export async function installLiveFixture(configDir, work, mode) {
  const accountPath = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
  const original = JSON.parse(await readFile(accountPath, "utf8"));
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify(
      Object.fromEntries(
        ["oauthAccount", "hasCompletedOnboarding", "lastOnboardingVersion", "theme"]
          .filter((key) => original[key] !== undefined)
          .map((key) => [key, original[key]]),
      ),
    ),
  );
  const fixtureMarket = `cerberus-probe-${mode}-${process.pid}`;
  const installedCli = (...args) =>
    execFileSync("claude", ["plugin", ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: "pipe",
    });
  await mkdir(join(work, ".claude-plugin"));
  await writeFile(
    join(work, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      name: fixtureMarket,
      owner: { name: "Probe" },
      plugins: [
        {
          name: "cerberus-probe-fixture",
          source: "./fixture",
          description: "Disposable observation fixture",
        },
      ],
    }),
  );
  installedCli("marketplace", "add", work);
  installedCli("install", "--scope", "user", `cerberus-probe-fixture@${fixtureMarket}`);
  return () => {
    installedCli("uninstall", "--scope", "user", `cerberus-probe-fixture@${fixtureMarket}`);
    installedCli("marketplace", "remove", fixtureMarket);
  };
}
