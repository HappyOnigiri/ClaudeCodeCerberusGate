import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "../scripts/check-lines.ts";
void test("physical line boundaries and justified exceptions", () => {
  assert.equal(inspect("").count, 0);
  assert.equal(inspect("x\nx").count, 2);
  assert.equal(inspect("x\n".repeat(599)).level, "ok");
  assert.equal(inspect("x\n".repeat(600)).level, "warning");
  assert.equal(inspect("x\n".repeat(999)).level, "warning");
  assert.equal(inspect("x\n".repeat(1000)).level, "error");
  assert.equal(
    inspect("// linelint:allow-long -- generated adapter\n" + "x\n".repeat(1000)).level,
    "warning",
  );
  assert.equal(inspect("// linelint:allow-long -- \n" + "x\n".repeat(1000)).level, "error");
  assert.equal(
    inspect("const x = 0;\n// linelint:allow-long -- misplaced\n" + "x\n".repeat(1000)).level,
    "error",
  );
});
