// No host or Node dependencies: capture values before callers mutate them.
export function safeValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "bigint") return String(item);
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.map(visit);
    const result: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(item),
      ...(item instanceof Error ? ["name", "message", "stack", "cause", "code"] : []),
    ])) {
      try {
        result[key] = visit(Reflect.get(item, key));
      } catch {
        result[key] = "[Unreadable]";
      }
    }
    return result;
  };
  try {
    return JSON.parse(JSON.stringify(visit(value)) ?? "null");
  } catch {
    return "[Unserializable]";
  }
}
export function createDebug() {
  let sessionId = "";
  let instanceId = "";
  let sequence = 0;
  let operation = 0;
  let batch = 0;
  let pending: Record<string, unknown>[] = [];
  let location: { directory: string; index: string; events: string } | undefined;
  let failure: unknown;
  return {
    start(id: string) {
      sessionId = id;
      instanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sequence = 0;
      operation = 0;
      batch = 0;
      pending = [];
      location = undefined;
      failure = undefined;
      return { sessionId, instanceId };
    },
    identity: () => ({ sessionId, instanceId }),
    operation: () => `${instanceId}-${++operation}`,
    record(event: string, data: unknown = {}, level = "info") {
      pending.push({
        version: 1,
        time: new Date().toISOString(),
        sequence: ++sequence,
        event,
        level,
        sessionId,
        instanceId,
        data: safeValue(data),
      });
    },
    take() {
      const records = pending;
      pending = [];
      if (records.length) batch++;
      return records.map((record) => ({ ...record, batch }));
    },
    saved(value: typeof location) {
      location = value;
    },
    failed(error: unknown) {
      failure = safeValue(error);
    },
    ready: () => location !== undefined,
    text: () =>
      [
        "Cerberus Gate: デバッグログ",
        `session ID: ${sessionId || "未初期化"}`,
        `instance ID: ${instanceId || "未初期化"}`,
        `保存状態: ${failure !== undefined ? "保存失敗" : location ? "保存済み" : "未保存"}`,
        ...(location
          ? [
              `保存ディレクトリ: ${location.directory}`,
              `索引: ${location.index}`,
              `現在のログ: ${location.events}`,
            ]
          : []),
      ].join("\n"),
  };
}
