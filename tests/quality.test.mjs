import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { lint } from "markdownlint/sync";
import MarkdownIt from "markdown-it";
import { inspect as architecture, check } from "../scripts/quality/architecture.mjs";
import { inspect as suppressions } from "../scripts/quality/suppressions.mjs";
import docs from "../scripts/quality/docs.mjs";
import { binary, verify } from "../scripts/quality/native.mjs";
import { coverage } from "../scripts/quality/coverage.mjs";
import { parse, sources } from "../scripts/quality/source.mjs";

const root = process.cwd();
const registration = "plugins/cerberus-gate/hooks/register.ts";
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: "utf8", ...options });
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "cerberus-quality-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}
test("architecture permits current registration and rejects forbidden dependencies and API indirection", async () => {
  assert.deepEqual(await check(root), []);
  for (const source of [
    'import x from "node:fs";',
    'export * from "./register.ts";',
    'export * from "./register";',
    'import x from "./register.js";',

    'const x = import("./register.ts");',
    "const x = import(name);",
    'import type { EngineInterface } from "claude-code";',
    'const x = require("node:fs");',
  ])
    assert.ok(architecture("plugins/cerberus-gate/hooks/pure.ts", source).length, source);
  for (const source of [
    '$.fs.write("file", "text");',
    '$["tool"].list();',
    "const call = $.tool.call;",
    "const host = $;",
    "const { tool } = $;",
    '$.tool.call({tool: "Write"});',
    "$.tool.call(options);",
    '$.tool.call({tool: "TaskStop", ...options});',
    '$.agent.register({name: "other"});',
    "$.agent.spawn({subagentType: UNKNOWN});",
    "function f(engine: EngineInterface) { engine.tool.list(); }",
  ])
    assert.ok(architecture(registration, source).length, source);
  assert.deepEqual(
    architecture(
      registration,
      'const STOP="TaskStop"; function f($: EngineInterface) { $.tool.call({tool: STOP}); }',
    ),
    [],
  );
  assert.deepEqual(
    architecture(
      registration,
      "function f($: EngineInterface) { $.agent.spawn({subagentType: REVIEWER}); }",
      new Map([["REVIEWER", "cerberus-gate:reviewer"]]),
    ),
    [],
  );
});
test("source discovery and parsing fail closed", async (t) => {
  const path = await fixture(t);
  await mkdir(join(path, "plugins"));
  await assert.rejects(sources(path, ["plugins"]), /no source files/u);
  await assert.rejects(check(path), /no source files/u);
  assert.throws(() => parse("broken.ts", "const = ;"), /parse:/u);
});
test("suppression directives require named rules and reasons in line and block comments", () => {
  for (const source of [
    "// oxlint-disable\n",
    "/* eslint-disable no-console */",
    "// oxlint-disable-next-line no-console --\nconsole.log(1);",
    "/* oxlint-enable */",
  ])
    assert.ok(suppressions("x.js", source).length, source);
  for (const source of [
    "// oxlint-disable-next-line no-console -- fixture logger\nconsole.log(1);",
    "/* eslint-disable no-console, no-alert -- fixture logger */",
    "/* oxlint-enable no-console */",
    'const text = "// oxlint-disable";',
  ])
    assert.deepEqual(suppressions("x.js", source), [], source);
});
test("Oxlint rejects unused suppressions and excessive complexity", async (t) => {
  const path = await fixture(t);
  await writeFile(
    join(path, "unused.js"),
    "// oxlint-disable-next-line no-debugger -- fixture\nconsole.log(1);\n",
  );
  const unused = run(resolve("node_modules/.bin/oxlint"), [
    "--report-unused-disable-directives-severity=error",
    join(path, "unused.js"),
  ]);
  assert.equal(unused.status, 1, unused.stdout + unused.stderr);
  assert.match(unused.stdout + unused.stderr, /unused|not used/iu);
  const source = `export function complex(x) { ${Array.from({ length: 40 }, (_, i) => `if(x === ${i}) return ${i};`).join(" ")} return -1; }`;
  await writeFile(join(path, "complex.js"), source);
  const complexity = run(resolve("node_modules/.bin/oxlint"), [
    "--config",
    resolve(".oxlintrc.json"),
    join(path, "complex.js"),
  ]);
  assert.equal(complexity.status, 1, complexity.stdout + complexity.stderr);
  assert.match(complexity.stdout + complexity.stderr, /complexity/u);
});
test("docs rules resolve inline, encoded and reference links and require the docs index", async (t) => {
  const path = await fixture(t);
  await mkdir(join(path, "docs"));
  await writeFile(join(path, "docs/a b.md"), "# Target\n");
  const inspect = (name, text) =>
    Object.values(
      lint({
        strings: { [join(path, name)]: text },
        customRules: [docs],
        markdownItFactory: () => new MarkdownIt(),
        config: { default: false, CG001: { root: path } },
      }),
    )
      .flat()
      .map((error) => error.errorDetail)
      .join("\n");
  assert.equal(
    inspect(
      "AGENTS.md",
      "# Instructions\n\n## docs インデックス\n\n[doc][a]\n\n[a]: /docs/a%20b.md\n",
    ),
    "",
  );
  assert.match(inspect("AGENTS.md", "# Instructions\n"), /missing docs/u);
  assert.match(inspect("README.md", "[bad](missing.md)\n"), /missing or outside/u);
  assert.match(inspect("README.md", "[bad](../outside.md)\n"), /outside/u);
  assert.match(inspect("README.md", "[bad](bad%ZZ.md)\n"), /missing or outside/u);
  assert.equal(
    inspect(
      "README.md",
      "[doc](docs/a%20b.md#ignored)\n\n`[fake](missing.md)`\n\n```md\n[fake](missing.md)\n```\n",
    ),
    "",
  );
  assert.equal(
    inspect("docs/other.md", "[doc](a%20b.md)\n\n[external](https://example.com/missing)\n"),
    "",
  );
});
test("real native tools reject invalid workflow and shell fixtures", async (t) => {
  const path = await fixture(t);
  await writeFile(
    join(path, "bad.yml"),
    'name: bad\non: push\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ unknown.value }}"\n',
  );
  await writeFile(join(path, "bad.sh"), "#!/bin/sh\necho $unquoted\n");
  const workflow = run(binary("actionlint"), [
    "-shellcheck",
    binary("shellcheck"),
    join(path, "bad.yml"),
  ]);
  assert.equal(workflow.status, 1, workflow.stdout + workflow.stderr);
  assert.match(workflow.stdout + workflow.stderr, /bad.yml:\d+.*expression/u);
  const shell = run(binary("shellcheck"), ["--format=gcc", join(path, "bad.sh")]);
  assert.equal(shell.status, 1, shell.stdout + shell.stderr);
  assert.match(shell.stdout + shell.stderr, /bad.sh:\d+.*SC/u);
  assert.throws(() => verify(Buffer.from("corrupt"), "0".repeat(64)), /SHA-256 mismatch/u);
});
test("Knip reports unused files, exports and dependencies without hiding undeclared imports", async (t) => {
  const path = await fixture(t);
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ type: "module", devDependencies: { "oxc-parser": "0.155.0" } }),
  );
  await writeFile(
    join(path, "knip.json"),
    JSON.stringify({ entry: ["index.js"], project: ["*.js"] }),
  );
  await writeFile(
    join(path, "index.js"),
    'import {used} from "./helper.js"; import "undeclared-fixture"; console.log(used);',
  );
  await writeFile(join(path, "helper.js"), "export const used=1; export const unused=2;");
  await writeFile(join(path, "dead.js"), 'console.log("dead");');
  const result = run(resolve("node_modules/.bin/knip"), [
    "--directory",
    path,
    "--config",
    join(path, "knip.json"),
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const name of ["dead.js", "unused", "oxc-parser", "undeclared-fixture"])
    assert.ok((result.stdout + result.stderr).includes(name), result.stdout + result.stderr);
});
test("Verdict, delivery modes and phases cannot grow silently", async (t) => {
  const path = await fixture(t);
  await cp("plugins/cerberus-gate/hooks", join(path, "hooks"), { recursive: true });
  const original = await readFile(join(path, "hooks/state.ts"), "utf8");
  const policy = await readFile(join(path, "hooks/policy.ts"), "utf8");
  const config = JSON.parse(await readFile("tsconfig.json", "utf8"));
  config.compilerOptions.typeRoots = [resolve("types")];
  config.include = ["hooks"];
  await writeFile(join(path, "tsconfig.json"), JSON.stringify(config));
  for (const mode of ["verdict", "delivery", "phase"]) {
    await writeFile(
      join(path, "hooks/policy.ts"),
      mode === "verdict"
        ? policy.replace('decision: "PASS"', 'decision: "ADDED" | "PASS"')
        : policy,
    );
    await writeFile(
      join(path, "hooks/state.ts"),
      mode === "delivery"
        ? original.replace('mode: "publish"', 'mode: "added" | "publish"')
        : mode === "phase"
          ? original.replace('phase: "idle" as Phase', 'phase: "unknown" as Phase') +
            '\nconst state = createState(); state.phase = "invalid";\n'
          : original,
    );
    const result = run(resolve("node_modules/.bin/tsc"), [
      "--project",
      join(path, "tsconfig.json"),
    ]);
    assert.notEqual(result.status, 0, mode);
    assert.match(
      result.stdout,
      mode === "delivery" ? /never/u : mode === "verdict" ? /ADDED/u : /invalid/u,
    );
  }
});
test("coverage propagates test failures and generates an LCOV report on success", async (t) => {
  const path = await fixture(t);
  await writeFile(
    join(path, "bad.test.mjs"),
    'import {test} from "node:test"; test("fails",()=>{throw Error("expected failure")});',
  );
  assert.notEqual(coverage([join(path, "bad.test.mjs")], join(path, "bad.info"), "pipe"), 0);
  await writeFile(
    join(path, "ok.test.mjs"),
    `import {test} from "node:test"; import {createState} from ${JSON.stringify(new URL("../plugins/cerberus-gate/hooks/state.ts", import.meta.url).href)}; test("state",()=>createState());`,
  );
  assert.equal(coverage([join(path, "ok.test.mjs")], join(path, "ok.info"), "pipe"), 0);
  assert.match(await readFile(join(path, "ok.info"), "utf8"), /SF:.*state.ts/u);
  assert.throws(() => coverage([], join(path, "empty.info")), /no Node tests/u);
});

test("native checks reject empty targets and missing tools", async (t) => {
  const path = await fixture(t);
  await mkdir(join(path, "scripts"));
  const script = resolve("scripts/quality/native.mjs");
  const empty = run(process.execPath, [script, "shell"], { cwd: path });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /targets: no scripts/u);
  await writeFile(join(path, "scripts/probe.sh"), "#!/bin/sh\necho ok\n");
  const missing = run(process.execPath, [script, "shell"], { cwd: path });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing-tool: run npm run setup:checks/u);
});
