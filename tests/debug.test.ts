import { asFixture } from "./helpers/fixture.ts";
import type { TestContext } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createDebug, safeValue } from "../plugins/cerberus-gate/hooks/debug.ts";

const helper = "plugins/cerberus-gate/hooks/debug-log.mts";
function invoke(root: string, operation: string, input: unknown) {
  return spawnSync(process.execPath, [helper, operation], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: root },
  });
}
async function workspace(t: TestContext) {
  const work = await mkdtemp(join(tmpdir(), "cerberus-debug-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  return work;
}
void test("index discovers independent instances and preserves complete lines before a torn tail", async (t) => {
  const work = await workspace(t);
  for (const instanceId of ["first", "second"]) {
    const identity = { sessionId: "session", instanceId };
    const initialized = invoke(work, "initialize", identity);
    assert.equal(initialized.status, 0, initialized.stderr);
    const location = JSON.parse(initialized.stdout);
    assert.equal((await stat(location.instance)).mode & 0o777, 0o700);
    assert.equal((await stat(location.events)).mode & 0o777, 0o600);
    assert.equal(
      invoke(work, "append", { ...identity, records: [{ sequence: 1, event: "model.start" }] })
        .status,
      0,
    );
    assert.equal(invoke(work, "initialize", identity).status, 1);
  }
  const session = join(work, "cerberus-gate/debug/session");
  const index = (await readFile(join(session, "index.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    index.map((r) => r.instanceId),
    ["first", "second"],
  );
  for (const record of index)
    assert.equal(
      JSON.parse((await readFile(join(session, record.path), "utf8")).trim()).event,
      "model.start",
    );
  assert.equal(
    invoke(work, "append", { sessionId: "another", instanceId: "first", records: [] }).status,
    1,
  );
  assert.equal((await readFile(join(session, "index.jsonl"), "utf8")).trim().split("\n").length, 2);
});
void test("debug helper rejects traversal, symlink directories and symlink or hardlink files", async (t) => {
  const work = await workspace(t);
  const input = { sessionId: "session", instanceId: "first" };
  assert.equal(invoke(work, "initialize", { ...input, sessionId: "../escape" }).status, 1);
  const outside = join(work, "outside");
  await mkdir(outside);
  await symlink(outside, join(work, "cerberus-gate"));
  assert.equal(invoke(work, "initialize", input).status, 1);
  await rm(join(work, "cerberus-gate"));
  const location = JSON.parse(invoke(work, "initialize", input).stdout);
  const target = join(outside, "target");
  await writeFile(target, "unchanged");
  await rm(location.events);
  for (const make of [symlink, link]) {
    await make(target, location.events);
    assert.equal(invoke(work, "append", { ...input, records: [{ secret: true }] }).status, 1);
    assert.equal(await readFile(target, "utf8"), "unchanged");
    await rm(location.events);
  }
});
void test("debug helper stores large multibyte records without replacement characters", async (t) => {
  const work = await workspace(t);
  const identity = { sessionId: "session", instanceId: "first" };
  const location = JSON.parse(invoke(work, "initialize", identity).stdout);
  // Larger than one pipe read, so a 3-byte character straddles a read boundary.
  const text = "ギフトタイムラインイベント視聴\n".repeat(6000);
  const records = [{ sequence: 1, event: "prompt.received", data: { prompt: { text } } }];
  const appended = invoke(work, "append", { ...identity, records });
  assert.equal(appended.status, 0, appended.stderr);
  const saved = JSON.parse((await readFile(location.events, "utf8")).trim());
  assert.equal(saved.data.prompt.text, text);
});
void test("serializer preserves exceptions and full arrays without failing on cycles or thrown values", () => {
  const error = Object.assign(new Error("outer", { cause: new Error("inner") }), {
    code: "",
    circular: null as Error | null,
  });
  error.code = "EFAIL";
  error.circular = error;
  const saved = asFixture<{
    error: { message: string; cause: { message: string }; circular: string; code: string };
    values: unknown[];
  }>(safeValue({ error, values: ["full", { nested: true }], number: 1n }));
  assert.equal(saved.error.message, "outer");
  assert.equal(saved.error.cause.message, "inner");
  assert.equal(saved.error.circular, "[Circular]");
  assert.equal(saved.error.code, "EFAIL");
  assert.deepEqual(saved.values, ["full", { nested: true }]);
  assert.equal(safeValue("thrown string"), "thrown string");
  assert.equal(
    safeValue(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("proxy");
          },
        },
      ),
    ),
    "[Unserializable]",
  );
  const logger = createDebug();
  logger.start("session");
  const mutable = { value: "before" };
  logger.record("start", mutable);
  mutable.value = "after";
  logger.record("end", error);
  assert.deepEqual(
    logger.take().map((r) => [Reflect.get(r, "sequence"), Reflect.get(r, "event")]),
    [
      [1, "start"],
      [2, "end"],
    ],
  );
  assert.deepEqual(logger.take(), []);
  logger.failed(error);
  assert.match(logger.text(), /Save failed/u);
  assert.doesNotMatch(logger.text(), /outer|inner/u);
});
