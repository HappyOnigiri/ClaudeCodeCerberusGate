import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const old = "cerberus-gate@happyonigiri-plugins";
const fresh = "cerberus-gate@cerberus-gate";
const display = (id) => id.replace("cerberus-gate@", "cerberus-gate-display@");
const options = {
  reviewerModel: "haiku",
  maxRevisions: 3,
  enabled: false,
  reviewPrompt: "secret\ncriteria",
};
async function fixture(
  t,
  { active = true, settings, scope = "user", fail = "", market = [] } = {},
) {
  const work = await mkdtemp(join(tmpdir(), "cerberus-migrate-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const config = join(work, "config");
  const bin = join(work, "bin");
  await mkdir(config);
  await mkdir(bin);
  const original = settings ?? {
    enabledPlugins: { [old]: active, [display(old)]: active, "other@shared": true },
    pluginConfigs: {
      [old]: { options: { ...options, readOnlyMcpTools: "retired" } },
      "other@shared": { options: { keep: 42 } },
    },
    unrelated: { keep: true },
  };
  await writeFile(
    join(config, "settings.json"),
    typeof original === "string" ? original : JSON.stringify(original),
  );
  await writeFile(
    join(config, "state.json"),
    JSON.stringify({
      installed: [old, display(old)].map((id) => ({
        id,
        scope,
        enabled: active,
        projectPath: scope === "user" ? undefined : "/project",
      })),
      market,
      calls: [],
    }),
  );
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.CLAUDE_CONFIG_DIR;
const state = JSON.parse(fs.readFileSync(dir+'/state.json'));
const settings = JSON.parse(fs.readFileSync(dir+'/settings.json'));
const args = process.argv.slice(3);
state.calls.push(args);
fs.writeFileSync(dir+'/state.json', JSON.stringify(state));
const id = args.at(-1);
const failed = process.env.MIGRATE_FAIL;
if (args[0] === 'list') {
  console.log(JSON.stringify(state.installed.map(i => ({...i, enabled: settings.enabledPlugins?.[i.id] ?? i.enabled}))));
} else if (args.join(' ') === 'marketplace list --json') console.log(JSON.stringify(state.market));
else if (args[0] === 'marketplace') state.market.push({name:'cerberus-gate', source:'github',repo:'HappyOnigiri/ClaudeCodeCerberusGate'});
else {
  settings.enabledPlugins ??= {};
  if (args[0] === 'install') {
    state.installed.push(...[id,id.replace('cerberus-gate@','cerberus-gate-display@')].map(id => ({id,scope:'user',enabled:true})));
    for (const i of state.installed.filter(i=>i.id.endsWith('@cerberus-gate'))) settings.enabledPlugins[i.id] = true;
    settings.installMarker = true;
  } else settings.enabledPlugins[id] = args[0] === 'enable';
  fs.writeFileSync(dir+'/settings.json', JSON.stringify(settings));
}
fs.writeFileSync(dir+'/state.json', JSON.stringify(state));
if ((failed === 'enable' && args[0] === 'enable') || (failed === 'install' && args[0] === 'install') ||
    (failed === 'disable' && args[0] === 'disable' && id === '${display(old)}') ||
    (failed === 'rollback' && ['install','disable'].includes(args[0]))) process.exit(1);
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync(process.execPath, [resolve("scripts/migrate.mjs")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_CONFIG_DIR: config,
        MIGRATE_FAIL: fail,
      },
      encoding: "utf8",
    });
  const read = async () => JSON.parse(await readFile(join(config, "settings.json"), "utf8"));
  const state = async () => JSON.parse(await readFile(join(config, "state.json"), "utf8"));
  return { run, read, state, original };
}
for (const active of [true, false])
  test(`migration preserves native options, other settings and active=${active}; rerun is stable`, async (t) => {
    const f = await fixture(t, { active });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const saved = await f.read();
    assert.deepEqual(saved.pluginConfigs[fresh].options, options);
    assert.deepEqual(saved.pluginConfigs[old], f.original.pluginConfigs[old]);
    assert.deepEqual(saved.pluginConfigs["other@shared"], f.original.pluginConfigs["other@shared"]);
    assert.deepEqual(saved.unrelated, f.original.unrelated);
    assert.equal(saved.installMarker, true);
    for (const id of [fresh, display(fresh)]) assert.equal(saved.enabledPlugins[id], active);
    for (const id of [old, display(old)]) assert.equal(saved.enabledPlugins[id], false);
    assert.equal(saved.enabledPlugins["other@shared"], true);
    assert.ok(!r.stdout.includes("secret") && !r.stderr.includes("secret"));
    assert.equal(f.run().status, 0);
    assert.deepEqual(await f.read(), saved);
  });
for (const fail of ["install", "disable", "enable", "rollback"])
  test(`migration restores owned settings after ${fail} failure`, async (t) => {
    const f = await fixture(t, { fail });
    const r = f.run();
    assert.equal(r.status, 1);
    const saved = await f.read();
    for (const id of [old, display(old)]) assert.equal(saved.enabledPlugins[id], true);
    for (const id of [fresh, display(fresh)]) assert.equal(saved.enabledPlugins[id], false);
    assert.deepEqual(saved.pluginConfigs[fresh]?.options ?? {}, {});
    assert.deepEqual(saved.pluginConfigs[old], f.original.pluginConfigs[old]);
    assert.equal(saved.installMarker, true);
    assert.match(
      r.stderr,
      fail === "rollback" ? /rollback incomplete/ : /Previous settings restored/,
    );
  });
for (const [name, setup, pattern] of [
  [
    "conflict",
    {
      settings: {
        pluginConfigs: {
          [old]: { options },
          [fresh]: { options: { reviewPrompt: "different secret" } },
        },
      },
    },
    /Conflicting option keys: reviewPrompt/,
  ],
  ["invalid JSON", { settings: "{invalid" }, /Cannot parse settings/],
  [
    "invalid schema",
    { settings: { pluginConfigs: { [old]: { options: null } } } },
    /Invalid pluginConfigs/,
  ],
  ["other scope", { scope: "project" }, /project: \/project/],
  [
    "wrong source",
    { market: [{ name: "cerberus-gate", source: "github", repo: "someone/else" }] },
    /different source/,
  ],
])
  test(`migration refuses ${JSON.stringify(name)} without mutations`, async (t) => {
    const f = await fixture(t, setup);
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, pattern);
    assert.ok(!r.stderr.includes("different secret"));
    assert.ok(
      (await f.state()).calls.every(
        (a) => a[0] === "list" || a.join(" ") === "marketplace list --json",
      ),
    );
  });

test("migration merges matching public options while retaining public-only options", async (t) => {
  const f = await fixture(t, {
    settings: {
      enabledPlugins: { [old]: true, [display(old)]: false, [fresh]: false },
      pluginConfigs: {
        [old]: { options },
        [fresh]: { options: { reviewerModel: "haiku", futureOption: "retain" } },
      },
    },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await f.read()).pluginConfigs[fresh].options, {
    ...options,
    futureOption: "retain",
  });
});

test("migration refuses two enabled reviewers without changing settings", async (t) => {
  const f = await fixture(t, { settings: { enabledPlugins: { [old]: true, [fresh]: true } } });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Both reviewer IDs/);
  assert.deepEqual(await f.read(), f.original);
});
