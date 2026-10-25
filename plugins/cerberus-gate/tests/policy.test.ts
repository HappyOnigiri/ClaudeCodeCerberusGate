import { describe, expect, test } from "claude-code/testing";
import { allowedTool, parseVerdict, readConfig } from "../hooks/policy.ts";
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
        2,
        2,
      ),
    ).toBe("notice");
  });
  test("only explicit read tools, bounded options and no wildcard MCP names", () => {
    const config = readConfig({ readOnlyMcpTools: "mcp__notes__search" });
    expect(allowedTool("Read", config)).toBe(true);
    expect(allowedTool("mcp__notes__search", config)).toBe(true);
    expect(allowedTool("Bash", config)).toBe(false);
    expect(allowedTool("Write", config)).toBe(false);
    expect(allowedTool("mcp__notes__write", config)).toBe(false);
    expect(() => readConfig({ readOnlyMcpTools: "mcp__notes__*" })).toThrow();
    expect(() => readConfig({ maxRevisions: -1 })).toThrow();
    expect(() => readConfig({ reviewTimeoutSeconds: 0 })).toThrow();
  });
  test("a new user request invalidates an in-flight review", () => {
    const state = createState();
    reset(state, "old");
    const candidate = {
      token: 1,
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
