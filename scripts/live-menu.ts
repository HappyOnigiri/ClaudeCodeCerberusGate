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
    await pause(300);
  };
  await submit("/cgate");
  await capture("initial-menu.txt", t("menuCancel"));
  keys("Enter");
  await pause(500);
  await writeFile(join(artifacts, "initial-enter.txt"), screen());
  if (screen().includes(t("menuCancel")))
    throw new Error("Enter did not activate the initial menu item");
  keys("Enter");
  await capture("initial-back.txt", t("menuCancel"));
  keys("Down", "Enter");
  await capture("arrow-enter.txt", translate(language, "logHeader", ""));
  keys("Escape");
  await submit("/cgate language");
  await capture("language-picker.txt", "English");
  keys("BTab", "Enter");
  await capture("language-back.txt", t("modelPane"));
  keys("8");
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
  await capture("menu.txt", t("menuCancel"));
  if (/….*more/u.test(screen())) throw new Error("Menu still hides entries behind more");
  await pause(1200);
  keys("Enter");
  await pause(500);
  await writeFile(join(artifacts, "reload-enter.txt"), screen());
  if (screen().includes(t("menuCancel")))
    throw new Error("Enter did not activate menu after settings reload");
  keys("Escape");
  await submit("/cgate model");
  await capture("model-before-back.txt", "fable");
  keys("BTab", "Enter");
  await capture("model-back.txt", t("modelPane"));
  keys("Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Enter");
  await capture("model-reopened.txt", "fable");
}

export async function installMenuKeybindings(configDir: string) {
  await writeFile(
    join(configDir, "keybindings.json"),
    JSON.stringify({
      bindings: [
        { context: "Chat", bindings: { enter: "chat:newline", "ctrl+enter": "chat:submit" } },
        { context: "Pane", bindings: { enter: "abovePrompt:press" } },
      ],
    }),
  );
}
