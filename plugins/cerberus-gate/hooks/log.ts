import { translate } from "./locale.ts";
import type { Language } from "./locale.ts";
import { formatFindings } from "./policy.ts";

const MAX_ENTRIES = 1000;

// 原稿・依頼本文・例外の詳細は渡さず、処理の経過と審査の指摘を保持する。
export function createLog(language: () => Language = () => "en") {
  const t = (key: Parameters<typeof translate>[1], ...values: (string | number)[]) =>
    translate(language(), key, ...values);
  const entries: { time: Promise<string>; message: string }[] = [];
  let omitted = 0;
  return {
    record(now: Promise<number>, message: string, findings: readonly string[] = []): void {
      const time = now.then((ms) => new Date(ms).toISOString()).catch(() => t("unknownTime"));
      entries.push({
        time,
        message: findings.length ? `${message}\n${formatFindings(findings, language())}` : message,
      });
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
      if (entries.length === 0) return t("noLogs");
      const header = t("logHeader", omitted ? t("omitted", omitted) : "");
      const lines = await Promise.all(
        entries.map(async (entry) => `[${await entry.time}] ${entry.message}`),
      );
      return [header, ...lines].join("\n");
    },
  };
}
