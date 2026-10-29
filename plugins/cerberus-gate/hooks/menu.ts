import type { Config } from "./policy.ts";

export const phases = {
  idle: "phaseIdle",
  reviewing: "phaseReviewing",
  "correction queued": "phaseCorrection",
  publish: "phasePublished",
  notice: "phaseUnverified",
  published: "phasePublished",
  unverified: "phaseUnverified",
  cancelled: "phaseCancelled",
} as const;
const settings = {
  "reviewer-model": {
    key: "reviewerModel",
    label: "modelLabel",
    saved: "modelSaved",
    denied: "modelDenied",
    failure: "modelFailure",
    mobile: "mobileModel",
  },
  "reviewer-effort": {
    key: "reviewerEffort",
    label: "effortLabel",
    saved: "effortSaved",
    denied: "effortDenied",
    failure: "effortFailure",
    mobile: "mobileEffort",
  },
  language: {
    key: "language",
    label: "languageLabel",
    saved: "languageSaved",
    denied: "languageDenied",
    failure: "languageFailure",
    mobile: "mobileLanguage",
  },
} as const;
export function settingFor(id: string, config: Config) {
  const setting =
    settings[id === "reviewer-model" ? id : id === "reviewer-effort" ? id : "language"];
  const values =
    setting.key === "reviewerModel"
      ? [...new Set(["inherit", "haiku", "sonnet", "opus", "fable", config.reviewerModel])]
      : setting.key === "reviewerEffort"
        ? ["inherit", "low", "medium", "high", "xhigh", "max"]
        : ["en", "ja"];
  return { ...setting, values, value: config[setting.key] };
}

export const menuItems = [
  ["status", "menuStatus"],
  ["history", "historyPane"],
  ["log", "menuLog"],
  ["on", "menuOn"],
  ["off", "menuOff"],
  ["reset", "menuReset"],
  ["model", "modelPane"],
  ["language", "languageLabel"],
  ["cancel", "menuCancel"],
] as const;
