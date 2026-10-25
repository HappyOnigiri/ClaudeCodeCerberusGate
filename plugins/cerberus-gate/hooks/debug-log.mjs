import manifest from "../.claude-plugin/plugin.json" with { type: "json" };
import { safeValue } from "./debug.ts";
import { open, mkdir, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, parse } from "node:path";
import { fileURLToPath } from "node:url";

function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]+$/u.test(value))
    throw new Error("Invalid debug identifier");
  return value;
}
// Check every component, including configured ancestors; never follow a symlink.
async function directory(path, privateRoot = path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe debug directory");
    if (current === privateRoot || current.startsWith(privateRoot + "/")) {
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
  }
  return absolute;
}
async function append(path, text, exclusive = false, create = true, signal) {
  signal?.throwIfAborted();
  const existing = await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
    throw new Error("Unsafe debug file");
  const handle = await open(
    path,
    constants.O_WRONLY |
      (create ? constants.O_CREAT : 0) |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_APPEND),
    0o600,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe debug file");
    await handle.chmod(0o600);
    await handle.writeFile(text, { signal });
  } finally {
    await handle.close();
  }
}
async function appendIndex(path, text) {
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      append(path, text, false, true, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Index append timeout"));
        }, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function paths(sessionId, instanceId) {
  const root = await realpath(resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")));
  const session = join(root, "cerberus-gate", "debug", identifier(sessionId));
  const instance = join(session, identifier(instanceId));
  await directory(instance, join(root, "cerberus-gate"));
  return {
    directory: session,
    index: join(session, "index.jsonl"),
    events: join(instance, "events.jsonl"),
    instance,
  };
}
async function initialize(input) {
  const location = await paths(input.sessionId, input.instanceId);
  await append(location.events, "", true);
  await appendIndex(
    location.index,
    JSON.stringify({
      version: 1,
      time: new Date().toISOString(),
      kind: "instance",
      instanceId: input.instanceId,
      path: `${input.instanceId}/events.jsonl`,
    }) + "\n",
  );
  return { ...location, pluginVersion: manifest.version };
}
async function appendEvents(input) {
  const location = await paths(input.sessionId, input.instanceId);
  if (!Array.isArray(input.records)) throw new Error("Invalid records");
  await append(
    location.events,
    input.records.map((record) => JSON.stringify(record) + "\n").join(""),
    false,
    false,
  );
}
// Only the material helper calls this function, with the three freshly generated contents.
export async function preserve(input, material, contents) {
  const location = await paths(input.sessionId, input.instanceId);
  const reviewId = identifier(input.reviewId);
  const review = await directory(join(location.instance, "reviews", reviewId), location.instance);
  const saved = [];
  try {
    for (const name of ["source.jsonl", "users.txt", "history.txt"]) {
      await append(join(review, name), contents[name], true);
      saved.push(name);
      await appendIndex(
        location.index,
        JSON.stringify({
          version: 1,
          time: new Date().toISOString(),
          kind: "material",
          instanceId: input.instanceId,
          reviewId,
          path: `${input.instanceId}/reviews/${reviewId}/${name}`,
          sourcePath: material.sourcePath,
          bytes: material.bytes,
          lines: material.lines,
        }) + "\n",
      );
    }
    return { state: "saved", directory: review, files: saved };
  } catch (error) {
    return {
      state: "failed",
      directory: review,
      files: saved,
      error: safeValue(error),
    };
  }
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) === fileURLToPath(import.meta.url)
) {
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    if (process.argv[2] === "initialize") console.log(JSON.stringify(await initialize(input)));
    else if (process.argv[2] === "append") await appendEvents(input);
    else throw new Error("Unknown debug operation");
  } catch (error) {
    console.error(JSON.stringify(safeValue(error)));
    process.exitCode = 1;
  }
}
