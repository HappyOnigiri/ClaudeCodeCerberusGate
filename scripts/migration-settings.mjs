import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export async function readSettings(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot parse settings: ${path}`, { cause: error });
  }
  if (!object(value)) throw new Error(`Invalid settings object: ${path}`);
  for (const key of ["enabledPlugins", "pluginConfigs"])
    if (value[key] !== undefined && !object(value[key]))
      throw new Error(`Invalid settings field: ${key}`);
  if (Object.values(value.enabledPlugins ?? {}).some((item) => typeof item !== "boolean"))
    throw new Error("Invalid enabledPlugins value");
  for (const item of Object.values(value.pluginConfigs ?? {}))
    if (!object(item) || (item.options !== undefined && !object(item.options)))
      throw new Error("Invalid pluginConfigs entry");
  return value;
}

// Re-read immediately before each patch. Never restore an old copy of the settings file.
export async function patchSettings(path, change) {
  const current = await readSettings(path);
  change(current);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
