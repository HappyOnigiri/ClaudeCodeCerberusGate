import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export default {
  names: ["CG001", "repository-docs"],
  description: "Repository links and docs index must be complete",
  tags: ["repository"],
  parser: "markdownit",
  function(params, onError) {
    const root = realpathSync(resolve(params.config.root ?? process.cwd()));
    const file = resolve(root, params.name);
    const tokens = params.parsers.markdownit.tokens;
    const indexed = new Set();
    let inIndex = false;
    let heading;
    for (const token of tokens) {
      if (token.type === "heading_open") heading = token.tag;
      if (token.type === "inline" && heading) {
        if (heading === "h2") inIndex = token.content === "docs インデックス";
        heading = undefined;
      }
      for (const child of token.children ?? []) {
        const url =
          child.type === "link_open"
            ? child.attrGet("href")
            : child.type === "image"
              ? child.attrGet("src")
              : undefined;
        if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(url)) continue;
        try {
          const path = decodeURIComponent(url.split(/[?#]/u)[0]);
          if (!path) continue;
          const target = resolve(
            path.startsWith("/") ? root : dirname(file),
            path.replace(/^\//u, ""),
          );
          const within = (p) => {
            const rel = relative(root, p);
            return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
          };
          if (!within(target) || !existsSync(target) || !within(realpathSync(target)))
            throw new Error("missing or outside repository");
          if (inIndex) indexed.add(target);
        } catch (error) {
          onError({ lineNumber: token.lineNumber, detail: `${url}: ${error.message}` });
        }
      }
    }
    if (file === resolve(root, "AGENTS.md")) {
      const docs = readdirSync(resolve(root, "docs"), {
        recursive: true,
        withFileTypes: true,
      }).filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
      if (!docs.length) onError({ lineNumber: 1, detail: "docs index has no document targets" });
      for (const entry of docs) {
        const path = resolve(entry.parentPath, entry.name);
        if (!indexed.has(path))
          onError({ lineNumber: 1, detail: `docs index is missing ${relative(root, path)}` });
      }
    }
  },
};
