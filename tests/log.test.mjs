import { test } from "node:test";
import assert from "node:assert/strict";
import { createLog } from "../plugins/cerberus-gate/hooks/log.ts";

test("logs retain the latest 1000 entries in event order even when clocks resolve out of order", async () => {
  const log = createLog();
  const resolveTimes = [];
  const engine = { clock: { now: () => new Promise((resolve) => resolveTimes.push(resolve)) } };
  for (let i = 0; i < 1002; i++) log.record(engine.clock.now(), `event-${i}`);
  for (let i = resolveTimes.length - 1; i >= 0; i--) resolveTimes[i](i);
  const text = await log.text();
  assert.match(text, /古い 2 件を省略/u);
  assert.doesNotMatch(text, /event-[01]\n/u);
  assert.match(text, /event-2\n[\s\S]*event-1001$/u);
  log.clear();
  assert.match(await log.text(), /ログはありません/u);
  log.record(engine.clock.now(), "fresh");
  resolveTimes.at(-1)(0);
  assert.doesNotMatch(await log.text(), /省略/u);
});

test("logging tolerates unavailable clocks and never mixes independent logs", async () => {
  const first = createLog();
  const second = createLog();
  first.record(Promise.reject(new Error("SECRET")), "開始");
  assert.match(await first.text(), /時刻不明.*開始/u);
  assert.doesNotMatch(await first.text(), /SECRET/u);
  assert.match(await second.text(), /ログはありません/u);
});
