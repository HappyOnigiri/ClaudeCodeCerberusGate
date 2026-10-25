import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function coverage(files, destination, stdio = "inherit") {
  if (!files.length) throw new Error("coverage:1: targets: no Node tests");
  mkdirSync(resolve(destination, ".."), { recursive: true });
  rmSync(destination, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-include=plugins/*/hooks/*.ts",
      "--test-coverage-include=plugins/*/hooks/*.mjs",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${destination}`,
      ...files,
    ],
    {
      stdio,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
      ),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (!readFileSync(destination, "utf8").includes("SF:"))
    throw new Error("coverage:1: report: empty LCOV");
  return 0;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = readdirSync("tests")
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => `tests/${f}`);
  process.exitCode = coverage(files, "tmp/coverage/lcov.info");
}
