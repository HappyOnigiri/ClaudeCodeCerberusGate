import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(
  await readFile(new URL("./native-tools.json", import.meta.url), "utf8"),
);
const platform = `${process.platform}-${process.arch}`;
const cache = resolve("node_modules/.cache/cerberus-checks", platform);
function entry(tool) {
  const spec = manifest[tool]?.[platform];
  if (!spec) throw new Error(`native:1: platform: unsupported ${tool} on ${platform}`);
  return spec;
}
export function binary(tool) {
  return join(cache, `${tool}-${entry(tool).sha256.slice(0, 16)}`);
}
export function verify(data, sha256) {
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw new Error("native:1: checksum: SHA-256 mismatch");
}
export async function setup() {
  await mkdir(cache, { recursive: true });
  for (const tool of Object.keys(manifest)) {
    const spec = entry(tool);
    const work = await mkdtemp(join(cache, "download-"));
    try {
      const response = await fetch(spec.url);
      if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      verify(archive, spec.sha256);
      const path = join(work, "archive.tar.gz");
      await writeFile(path, archive);
      execFileSync("tar", ["-xzf", path, "-C", work, spec.member]);
      const extracted = join(work, spec.member);
      await chmod(extracted, 0o755);
      await rename(extracted, binary(tool));
      console.log(`Installed ${tool}: ${binary(tool)}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
export function run(tool, args, options = {}) {
  try {
    return execFileSync(binary(tool), args, { encoding: "utf8", stdio: "inherit", ...options });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`${tool}:1: missing-tool: run npm run setup:checks`, { cause: error });
    throw error;
  }
}
async function lint(mode) {
  if (mode === "workflows") {
    const files = (await readdir(".github/workflows"))
      .filter((f) => /\.ya?ml$/u.test(f))
      .map((f) => `.github/workflows/${f}`);
    if (!files.length) throw new Error("workflows:1: targets: no workflows");
    run("actionlint", ["-shellcheck", binary("shellcheck"), ...files], {
      env: { ...process.env, PATH: `${cache}:${process.env.PATH}` },
    });
  } else if (mode === "shell") {
    const files = [];
    for (const e of await readdir("scripts", { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const file = join(e.parentPath, e.name);
      if (
        file.endsWith(".sh") ||
        /^#!.*\b(?:sh|bash|dash|ksh)\b/u.test(await readFile(file, "utf8"))
      )
        files.push(file);
    }
    if (!files.length) throw new Error("shell:1: targets: no scripts");
    run("shellcheck", ["--format=gcc", ...files]);
  } else throw new Error(`native:1: mode: unknown ${mode}`);
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "setup") await setup();
  else await lint(process.argv[2]);
}
