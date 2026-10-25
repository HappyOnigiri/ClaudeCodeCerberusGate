import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  appendFile,
  rm,
  stat,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { snapshot, expand, release } from "../plugins/cerberus-gate/hooks/session-log.mjs";

// Independently authored raw JSONL: content strings and block arrays, branches,
// internal records, a correction and a tool result longer than Read's usual window.
const raw =
  [
    '{"type":"user","sessionId":"session","uuid":"u1","parentUuid":null,"message":{"content":"古い制約: 回答は日本語。\\n追加の制約: 作業記録を残す。"}}',
    '{"type":"assistant","sessionId":"session","uuid":"a1","parentUuid":"u1","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"limits.ts"}}]}}',
    JSON.stringify({
      type: "user",
      sessionId: "session",
      uuid: "t1",
      parentUuid: "a1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "export const LIMIT = 7;\n" + "detail\n".repeat(5000) + "END_OF_LONG_RESULT",
          },
        ],
      },
    }),
    '{"type":"user","sessionId":"session","uuid":"u2","parentUuid":"t1","message":{"content":[{"type":"text","text":"訂正: 上限は定義を読んで判断して。"}]}}',
    '{"type":"system","subtype":"compact_boundary","uuid":"boundary","content":"management data"}',
    '{"type":"assistant","sessionId":"session","uuid":"branch","parentUuid":"u1","message":{"content":"superseded branch"}}',
  ].join("\n") + "\n";

test("mechanical expansion preserves old constraints, long results and raw provenance", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-source-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, "session.jsonl");
  await writeFile(source, raw);
  const material = await snapshot(source, "session");
  t.after(() => release(material.directory));
  const users = await readFile(material.users, "utf8"),
    history = await readFile(material.history, "utf8");
  assert.match(users, /古い制約: 回答は日本語。\n追加の制約: 作業記録を残す。/u);
  assert.match(users, /JSONL line 4; UUID u2/u);
  assert.doesNotMatch(users, /export const LIMIT|END_OF_LONG_RESULT/u);
  assert.match(history, /JSONL line 3; UUID t1; type user; parent a1/u);
  assert.match(history, /tool_use_id:\nread-1\ncontent:\nexport const LIMIT = 7;\ndetail/u);
  assert.match(history, /END_OF_LONG_RESULT/u);
  assert.match(history, /compact_boundary/u);
  assert.match(history, /UUID branch; type assistant; parent u1/u);
  assert.equal(await readFile(material.source, "utf8"), raw);
  await appendFile(source, '{"type":"progress"}\n');
  assert.equal(await readFile(material.source, "utf8"), raw);
  assert.equal(material.lines, 6);
  assert.equal((await stat(material.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(material.source)).mode & 0o777, 0o600);
});
test("missing, incomplete, malformed and mismatched logs fail instead of omitting records", async () => {
  assert.throws(() => expand(raw.slice(0, -1), "session"), /Incomplete/u);
  assert.throws(() => expand(raw + "{bad}\n", "session"));
  assert.throws(() => expand(raw, "other"), /Wrong session/u);
  assert.throws(() => expand('{"type":"progress"}\n', "session"), /No conversation/u);
  await assert.rejects(snapshot("/nonexistent/cerberus.jsonl", "session"));
  await assert.rejects(release(tmpdir()), /Invalid review directory/u);
});
test("CLI follows symlinked plugin paths and reports missing session as failure", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-command-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["plugins/cerberus-gate/hooks/session-log.mjs", "create"],
    {
      input: JSON.stringify({ sessionId: "not-a-real-session" }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: work },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("missing current request never yields a seemingly complete snapshot", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-request-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, "session.jsonl");
  await writeFile(source, raw);
  await assert.rejects(snapshot(source, "session", "not flushed yet"), /Current request/u);
});

test("CLI resolves only the current session and deletes only its own material", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cerberus-cli-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(join(work, "projects", "project"), { recursive: true });
  const source = join(work, "projects", "project", "session.jsonl");
  await writeFile(source, raw);
  const linked = join(work, "helper.mjs");
  await symlink(join(process.cwd(), "plugins/cerberus-gate/hooks/session-log.mjs"), linked);
  const invoke = (operation, input) =>
    spawnSync(process.execPath, [linked, operation], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: work },
    });
  const result = invoke("create", { sessionId: "session", request: "古い制約: 回答は日本語。" });
  assert.equal(result.status, 0, result.stderr);
  const material = JSON.parse(result.stdout);
  assert.equal(await readFile(material.source, "utf8"), raw);
  assert.equal(invoke("release", { directory: material.directory }).status, 0);
  await assert.rejects(stat(material.directory), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), raw);
  assert.equal(invoke("release", { directory: work }).status, 1);
  assert.equal(await readFile(source, "utf8"), raw);
});
