import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initialReleaseBump } from "../scripts/initial-release-bump.ts";

const pr = (title: string, body: string | null = null) => ({ title, body });

await test("initial release uses minor for feat, including scoped feat, before patches", () => {
  assert.equal(initialReleaseBump([pr("fix: bug"), pr("feat: feature")]), "minor");
  assert.equal(initialReleaseBump([pr("feat(ui): feature")]), "minor");
});
await test("initial release follows the shared patch prefixes", () => {
  for (const prefix of ["fix", "perf", "refactor", "chore", "ci", "docs", "build", "style", "test"])
    assert.equal(initialReleaseBump([pr(`${prefix}(scope): change`)]), "patch");
});
await test("breaking changes stop the initial auto release even when feat exists", () => {
  for (const change of [
    pr("feat!: change"),
    pr("fix(scope)!: change"),
    pr("fix: change", "Details\nBREAKING CHANGE: change"),
  ])
    assert.throws(() => initialReleaseBump([pr("feat: feature"), change]), /breaking change/);
});
await test("release PRs do not affect classification and unknown prefixes never default to patch", () => {
  assert.equal(initialReleaseBump([pr("release: v0.1.2")]), undefined);
  assert.equal(initialReleaseBump([pr("release(scope)!: v0.1.2"), pr("fix: bug")]), "patch");
  assert.equal(initialReleaseBump([]), undefined);
  assert.throws(() => initialReleaseBump([pr("Unclassified change")]), /Cannot determine/);
});

await test("initial release CLI reads all pages, ignores closed unmerged PRs and fails closed", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-initial-release-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "output");
  const summary = join(work, "summary");
  const fixture = join(work, "prs.json");
  const log = join(work, "args.json");
  await writeFile(
    join(work, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'api' || !args.includes('--paginate') || !args.includes('--slurp')) process.exit(99);
fs.writeFileSync(process.env.INITIAL_PROBE_LOG, JSON.stringify(args));
if (process.env.INITIAL_PROBE_FAILURE === 'true') process.exit(41);
process.stdout.write(fs.readFileSync(process.env.INITIAL_PROBE_FIXTURE, 'utf8'));
`,
    { mode: 0o755 },
  );
  const execute = (automatic = true, failure = false) =>
    spawnSync(process.execPath, [resolve("scripts/initial-release-bump.ts")], {
      env: {
        ...process.env,
        PATH: `${work}:${process.env.PATH}`,
        GH_REPO: "example/repo",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        AUTOMATIC_RELEASE: String(automatic),
        INITIAL_PROBE_LOG: log,
        INITIAL_PROBE_FIXTURE: fixture,
        INITIAL_PROBE_FAILURE: String(failure),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
  await writeFile(
    fixture,
    JSON.stringify([
      [
        { ...pr("feat!: never merged"), merged_at: null },
        { ...pr("fix: merged"), merged_at: "2026-10-01T00:00:00Z" },
      ],
      [{ ...pr("feat: merged"), merged_at: "2026-10-02T00:00:00Z" }],
    ]),
  );
  let result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(output, "utf8"), "bump=minor\n");
  assert.match(await readFile(log, "utf8"), /state=closed&base=main&per_page=100/u);
  await writeFile(output, "");
  await writeFile(fixture, "[]");
  result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(output, "utf8"), "skip=true\n");
  await writeFile(output, "");
  assert.notEqual(execute(false).status, 0);
  assert.notEqual(execute(true, true).status, 0);
  for (const invalid of [
    "not json",
    "{}",
    "[{}]",
    "[[null]]",
    '[[{"merged_at":"date","title":12,"body":null}]]',
  ]) {
    await writeFile(fixture, invalid);
    assert.notEqual(execute().status, 0);
    assert.equal(await readFile(output, "utf8"), "");
  }
});
