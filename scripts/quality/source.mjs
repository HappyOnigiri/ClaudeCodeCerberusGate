import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { parseSync } from "oxc-parser";

export async function sources(root, directories = ["plugins", "scripts", "tests"]) {
  const files = [];
  for (const directory of directories) {
    for (const entry of await readdir(resolve(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.(?:[cm]?js|tsx?)$/u.test(entry.name)) continue;
      const file = relative(root, resolve(entry.parentPath, entry.name));
      if (file.includes("/.claude-plugin/types/") || file.endsWith(".d.ts")) continue;
      const text = await readFile(resolve(root, file), "utf8");
      if (/^\/\/ Code generated .* DO NOT EDIT\./mu.test(text)) continue;
      files.push({ file, text });
    }
  }
  if (!files.length) throw new Error("source:1: targets: no source files");
  return files;
}
export function parse(file, text) {
  const result = parseSync(file, text, { showSemanticErrors: true });
  if (result.errors.length)
    throw new Error(`${file}:1: parse: ${result.errors.map((e) => e.message).join("; ")}`);
  return result;
}
export function walk(node, visit, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}
export function diagnostic(file, text, node, rule, message) {
  return `${file}:${text.slice(0, node.start).split("\n").length}: ${rule}: ${message}`;
}
