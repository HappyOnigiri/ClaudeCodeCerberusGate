const MAX_ENTRIES = 1000;

// 本文・指摘・例外の内容は渡さず、処理の経過だけを保持する。
export function createLog() {
  const entries: { time: Promise<string>; message: string }[] = [];
  let omitted = 0;
  return {
    record(now: Promise<number>, message: string): void {
      const time = now.then((ms) => new Date(ms).toISOString()).catch(() => "時刻不明");
      entries.push({ time, message });
      if (entries.length > MAX_ENTRIES) {
        entries.shift();
        omitted++;
      }
    },
    clear(): void {
      entries.length = 0;
      omitted = 0;
    },
    async text(): Promise<string> {
      if (entries.length === 0) return "Cerberus Gate: このセッションのログはありません。";
      const header = `Cerberus Gate: このセッションのログ（時刻は UTC）${omitted ? ` / 古い ${omitted} 件を省略` : ""}`;
      const lines = await Promise.all(
        entries.map(async (entry) => `[${await entry.time}] ${entry.message}`),
      );
      return [header, ...lines].join("\n");
    },
  };
}
