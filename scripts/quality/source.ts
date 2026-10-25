import type { Node } from "oxc-parser";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { parseSync } from "oxc-parser";

export async function sources(root: string, directories = ["plugins", "scripts", "tests"]) {
  const files = [];
  for (const directory of directories) {
    for (const entry of await readdir(resolve(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) continue;
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
export function parse(file: string, text: string) {
  const result = parseSync(file, text, { showSemanticErrors: true });
  if (result.errors.length)
    throw new Error(`${file}:1: parse: ${result.errors.map((e) => e.message).join("; ")}`);
  return result;
}
export function walk(
  node: unknown,
  visit: (node: Node, parent: Node | undefined) => void,
  parent?: Node,
) {
  if (!node || typeof node !== "object") return;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers traverse only ASTs returned by oxc-parser; object entries erase the node union
  const current = "type" in node ? (node as Node) : parent;
  if (current && current !== parent) visit(current, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, current));
    else if (value && typeof value === "object") walk(value, visit, current);
  }
}
export function diagnostic(
  file: string,
  text: string,
  node: { start: number },
  rule: string,
  message: string,
) {
  return `${file}:${text.slice(0, node.start).split("\n").length}: ${rule}: ${message}`;
}
