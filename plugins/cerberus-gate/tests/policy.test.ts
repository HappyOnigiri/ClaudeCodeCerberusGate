import { describe, expect, test } from "claude-code/testing";
import { parseVerdict, readConfig, REVIEW_PROMPT } from "../hooks/policy.ts";
import { createState, current, disposition, reset } from "../hooks/state.ts";

describe("review contract", () => {
  test("malformed, inconsistent and prose replies never pass", () => {
    for (const reply of [
      "",
      "PASS",
      '{"decision":"PASS","findings":["error"]}',
      '{"decision":"REVISE","findings":[]}',
      '{"decision":"PASS","findings":"none"}',
    ]) {
      expect(parseVerdict(reply).decision).toBe("UNVERIFIED");
    }
    expect(parseVerdict('{"decision":"PASS","findings":[]}').decision).toBe("PASS");
    expect(
      disposition(
        parseVerdict('{"decision":"REVISE","findings":["file.ts:1 contradicts the draft"]}'),
      ),
    ).toBe("revise");
  });
  test("bounded options and ignored legacy MCP setting", () => {
    expect(readConfig({ readOnlyMcpTools: "mcp__notes__*" }).enabled).toBe(true);
    expect(() => readConfig({ maxRevisions: -1 })).toThrow();
    expect(() => readConfig({ reviewTimeoutSeconds: 0 })).toThrow();
  });
  test("review criteria default, preserve multiline text and reject invalid values", () => {
    for (const reviewPrompt of [undefined, "", " \n "])
      expect(readConfig({ reviewPrompt }).reviewPrompt).toBe(REVIEW_PROMPT);
    expect(readConfig({ reviewPrompt: "Check sources.\nCheck assumptions." }).reviewPrompt).toBe(
      "Check sources.\nCheck assumptions.",
    );
    expect(readConfig({ reviewPrompt: "x".repeat(20_000) }).reviewPrompt.length).toBe(20_000);
    for (const reviewPrompt of [null, false, 42, {}, [], "x".repeat(20_001)])
      expect(() => readConfig({ reviewPrompt })).toThrow();
  });
  test("a new user request invalidates an in-flight review", () => {
    const state = createState();
    reset(state, "old");
    const candidate = {
      token: 1,
      stepIndex: 0,
      turnId: "t",
      epoch: state.epoch,
      text: "draft",
      context: "",
      controller: new AbortController(),
      timedOut: false,
    };
    state.active = candidate;
    expect(current(state, candidate)).toBe(true);
    reset(state, "new");
    expect(current(state, candidate)).toBe(false);
    expect(state.revisions).toBe(0);
  });
});
