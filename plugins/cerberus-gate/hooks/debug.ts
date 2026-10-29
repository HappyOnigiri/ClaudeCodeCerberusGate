import { translate } from "./locale.ts";
import type { Language } from "./locale.ts";
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
export function createDebug(language: () => Language = () => "en") {
  const t = (key: Parameters<typeof translate>[1], ...values: (string | number)[]) =>
    translate(language(), key, ...values);
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
        t("debugHeader"),
        `session ID: ${sessionId || t("uninitialized")}`,
        `instance ID: ${instanceId || t("uninitialized")}`,
        t(
          "storageStatus",
          failure !== undefined ? t("saveFailed") : location ? t("saved") : t("notSaved"),
        ),
        ...(location
          ? [
              t("directory", location.directory),
              t("index", location.index),
              t("currentLog", location.events),
            ]
          : []),
      ].join("\n"),
  };
}
