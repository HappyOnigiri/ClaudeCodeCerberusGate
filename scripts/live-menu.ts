import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { language, t } from "./live-language.ts";
import { translate } from "../plugins/cerberus-gate/hooks/locale.ts";

export async function verifyMenu(
  session: string,
  artifacts: string,
  settings: string,
  submit: (text: string) => Promise<void>,
) {
  const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });
  const keys = (...args: string[]) => tmux("send-keys", "-t", session, ...args);
  const screen = () => tmux("capture-pane", "-p", "-t", session);
  const capture = async (file: string, expected: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !screen().includes(expected)) await pause(100);
    const text = screen();
    await writeFile(join(artifacts, file), text);
    if (!text.includes(expected)) throw new Error(`Menu screen missing: ${expected}`);
  };
  await submit("/cgate language");
  await capture("language-picker.txt", "English");
  keys("BTab", "Enter");
  await capture("language-back.txt", t("modelPane"));
  keys("Home", "Down", "Down", "Down", "Down", "Down", "Down", "Down", "Enter");
  await capture("language-reopened.txt", "English");
  keys(language === "en" ? "Down" : "Up", "Enter");
  const other = language === "en" ? "ja" : "en";
  await capture("language-changed.txt", translate(other, "modelPane"));
  const saved = JSON.parse(await readFile(settings, "utf8"));
  if (
    !Object.values(saved.pluginConfigs ?? {}).some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        "options" in p &&
        typeof p.options === "object" &&
        p.options !== null &&
        "language" in p.options &&
        p.options.language === other,
    )
  )
    throw new Error("Language was not saved");
  keys("Escape");
  await submit("/cgate language");
  await capture("language-restore.txt", "English");
  keys(language === "en" ? "Up" : "Down", "Enter");
  await capture("menu.txt", t("modelPane"));
  keys("Escape");
  await submit("/cgate model");
  await capture("model-before-back.txt", "fable");
  keys("BTab", "Enter");
  await capture("model-back.txt", t("modelPane"));
  keys("Home", "Down", "Down", "Down", "Down", "Down", "Down", "Enter");
  await capture("model-reopened.txt", "fable");
}
