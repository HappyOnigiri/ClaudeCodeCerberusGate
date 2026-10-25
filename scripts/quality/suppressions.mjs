import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnostic, parse, sources } from "./source.mjs";

export function inspect(file, text) {
  const errors = [];
  for (const comment of parse(file, text).comments) {
    const value = comment.value
      .trim()
      .replace(/^\*\s?/gmu, "")
      .trim();
    const match = /^(?:oxlint|eslint)-(disable(?:-next-line|-line)?|enable)\b([\s\S]*)$/u.exec(
      value,
    );
    if (!match) continue;
    const [rules, ...reason] = match[2].split(/\s+--\s*/u);
    if (
      !/^\s*[\w@/-]+(?:\s*,\s*[\w@/-]+)*\s*$/u.test(rules) ||
      (match[1] !== "enable" && !reason.join(" -- ").trim())
    ) {
      errors.push(
        diagnostic(
          file,
          text,
          comment,
          "suppression",
          "name specific rules and provide -- reason (enable only needs rule names)",
        ),
      );
    }
  }
  return errors;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = (await sources(process.cwd())).flatMap(({ file, text }) => inspect(file, text));
  errors.forEach((e) => console.error(e));
  if (errors.length) process.exitCode = 1;
}
