import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("install deploys both plugins, keeps other marketplace entries and restores reviewer options", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-install-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = join(work, "source tree");
  const config = join(work, "config");
  const bin = join(work, "bin");
  const marketplace = join(config, "local-marketplaces/happyonigiri");
  const manifest = join(marketplace, ".claude-plugin/marketplace.json");
  const log = join(work, "calls.jsonl");
  const plugins = ["cerberus-gate", "cerberus-gate-display"];
  const id = (name) => `${name}@happyonigiri-plugins`;
  const options = {
    reviewerModel: "haiku",
    reviewerEffort: "low",
    maxRevisions: 3,
    reviewPrompt: "Check sources.\nCheck assumptions.",
  };
  await mkdir(bin, { recursive: true });
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  for (const name of plugins) {
    await cp(resolve("plugins", name), join(root, "plugins", name), { recursive: true });
    await mkdir(join(root, "plugins", name, ".claude-plugin/types"), { recursive: true });
    await writeFile(join(root, "plugins", name, ".claude-plugin/types", "generated.d.ts"), "");
  }
  const other = { name: "watchdog", source: "./watchdog", description: "keep me" };
  await writeFile(
    manifest,
    JSON.stringify({
      name: "happyonigiri-plugins",
      plugins: [other, ...plugins.map((name) => ({ name }))],
    }),
  );
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({ pluginConfigs: { [id("cerberus-gate")]: { options } } }),
  );
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('--values-stdin') ? fs.readFileSync(0, 'utf8') : '';
if (input && Object.values(JSON.parse(input)).some(v => /[\\r\\n]/u.test(v)))
  throw new Error('configure accepts only single-line strings');
const settingsPath = process.env.CLAUDE_CONFIG_DIR + '/settings.json';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (args[1] === 'uninstall') delete settings.pluginConfigs[args.at(-1)];
if (args[1] === 'install') {
  settings.pluginConfigs[args.at(-1)] = { enabled: true, options: { futureOption: 'keep' } };
  settings.installMarker = true;
}
fs.writeFileSync(settingsPath, JSON.stringify(settings));
fs.appendFileSync(process.env.INSTALL_PROBE_LOG, JSON.stringify({args,input})+'\\n');
if (args.join(' ') === 'plugin marketplace list --json') console.log('[{"name":"happyonigiri-plugins"}]');
if (args.join(' ') === 'plugin list --json') console.log(JSON.stringify(${JSON.stringify(plugins.map((name) => ({ id: id(name), scope: "user" })))}));
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then echo abc123; fi\n',
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [resolve("scripts/install.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_PROBE_LOG: log,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = JSON.parse(await readFile(manifest, "utf8")).plugins;
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.find((entry) => entry.name === "watchdog"),
    other,
  );
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  for (const name of plugins) {
    assert.equal(entries.filter((entry) => entry.name === name).length, 1);
    assert.ok(
      calls.some(
        ({ args }) => args.join(" ") === `plugin uninstall --keep-data --scope user ${id(name)}`,
      ),
    );
    assert.ok(
      calls.some(({ args }) => args.join(" ") === `plugin install --scope user ${id(name)}`),
    );
    const target = join(marketplace, name);
    assert.equal(
      await readFile(join(target, "hooks/register.ts"), "utf8"),
      await readFile(join(root, "plugins", name, "hooks/register.ts"), "utf8"),
    );
    const files = await readdir(target, { recursive: true });
    assert.ok(
      !files.some(
        (file) =>
          file === "tsconfig.json" || file.startsWith("tests") || file.includes("generated.d.ts"),
      ),
    );
  }
  assert.ok(!calls.some(({ args }) => args.includes("--values-stdin")));
  const restored = JSON.parse(await readFile(join(config, "settings.json"), "utf8"));
  assert.deepEqual(restored.pluginConfigs[id("cerberus-gate")], {
    enabled: true,
    options: { futureOption: "keep", ...options },
  });
  assert.equal(restored.installMarker, true);
  assert.deepEqual(restored.pluginConfigs[id("cerberus-gate-display")], {
    enabled: true,
    options: { futureOption: "keep" },
  });
});
