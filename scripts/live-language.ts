import { translate } from "../plugins/cerberus-gate/hooks/locale.ts";

const configured = process.env.CERBERUS_LANGUAGE ?? "en";
if (configured !== "en" && configured !== "ja") throw new Error("Invalid CERBERUS_LANGUAGE");
export const language = configured;
export const t = (key: Parameters<typeof translate>[1]) => translate(language, key);

export function verifyLanguage(request: { system: string; prompt: string }) {
  if (
    language === "ja"
      ? !request.system.includes("副作用のない調査")
      : !request.system.includes("side-effect-free investigation")
  )
    throw new Error("Reviewer system language mismatch");
  const prompt = JSON.parse(request.prompt.split("\n")[0]!);
  if (
    language === "ja"
      ? !prompt.replyFormat.includes("返してください")
      : !prompt.replyFormat.includes("Return exactly")
  )
    throw new Error("Reviewer prompt language mismatch");
}

export function historyMessage(mode: string): string {
  if (["history", "bounds", "environment", "causal", "revise"].includes(mode))
    return language === "ja" ? "修正を依頼しました" : "Requested correction";
  switch (mode) {
    case "timeout":
      return language === "ja" ? "タイムアウト" : "timed out";
    case "cap":
      return t("limitPublished");
    case "cancel":
      return t("cancelled");
    case "unverified":
    case "missing-log":
      return "UNVERIFIED";
    default:
      return t("published");
  }
}
