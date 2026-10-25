import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function inspect(text: string) {
  const count = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  const header = text.split("\n").slice(
    0,
    text.split("\n").findIndex((line) => line.trim() && !line.trim().startsWith("//")),
  );
  const marker = header.find((line) => line.includes("linelint:"));
  const allowed = marker && /^\s*\/\/\s*linelint:allow-long -- \S.*$/u.test(marker);
  if (marker && !allowed)
    return { level: "error", count, reason: "exception requires a reason in the leading comment" };
  if (count >= 1000 && !allowed)
    return { level: "error", count, reason: "split by responsibility; aim below 600 lines" };
  return { level: count >= 600 ? "warning" : "ok", count, reason: allowed ? marker.trim() : "" };
}

export async function check(root: string) {
  let errors = 0;
  for (const directory of ["plugins", "scripts"]) {
    for (const entry of await readdir(resolve(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        !/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) ||
        /(?:\.test\.|\.d\.ts$)/u.test(entry.name)
      )
        continue;
      const path = resolve(entry.parentPath, entry.name);
      if (path.includes("/.claude-plugin/types/")) continue;
      const text = await readFile(path, "utf8");
      if (/^\/\/ Code generated .* DO NOT EDIT\./mu.test(text)) continue;
      const result = inspect(text);
      if (result.level !== "ok")
        console.error(`${path}: ${result.level}: ${result.count} lines ${result.reason}`);
      if (result.level === "error") errors++;
    }
  }
  return errors;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  if (await check(process.cwd())) process.exitCode = 1;
}
