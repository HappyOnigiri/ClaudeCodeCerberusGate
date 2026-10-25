import { resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnostic, parse, sources, walk } from "./source.mjs";

const registration = "plugins/cerberus-gate/hooks/register.ts";
const api = new Set([
  "agent.list",
  "agent.register",
  "agent.spawn",
  "clock.now",
  "clock.after",
  "command.register",
  "prompt.submit",
  "session.messages",
  "session.version",
  "tool.list",
  "tool.call",
  "ui.status",
]);
const engineNames = new Set(["$", "_$"]);
function chain(node) {
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression") return [];
  return [...chain(node.object), node.computed ? "<computed>" : node.property.name];
}
function constants(program) {
  const values = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier" && item.init?.type === "Literal")
        values.set(item.id.name, item.init.value);
    }
  }
  return values;
}
export function inspect(file, text, importedConstants = new Map()) {
  const { program } = parse(file, text);
  const errors = [];
  const report = (n, rule, message) => errors.push(diagnostic(file, text, n, rule, message));
  const privileged = file === registration;
  const values = new Map([...importedConstants, ...constants(program)]);
  const bindings = new Map();
  const bind = (id) =>
    walk(id, (n) => {
      if (n.type === "Identifier") bindings.set(n.name, (bindings.get(n.name) ?? 0) + 1);
    });
  walk(program, (n) => {
    if (n.type === "VariableDeclarator") bind(n.id);
    if (n.params) n.params.forEach(bind);
    if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") bind(n.id);
    if (n.type === "CatchClause") bind(n.param);
    if (n.type.startsWith("Import") && n.local) bind(n.local);
  });
  for (const [name, count] of bindings) if (count > 1) values.delete(name);
  const aliases = new Map();
  walk(program, (n) => {
    if (n.type === "TSTypeAliasDeclaration") aliases.set(n.id.name, n.typeAnnotation);
  });
  const typeName = (annotation) => {
    let name = annotation?.typeName?.name;
    const seen = new Set();
    while (aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      name = aliases.get(name)?.typeName?.name;
    }
    return name;
  };
  const helpers = new Set();
  const parameters = new Set();
  walk(program, (n, parent) => {
    if (n.params) {
      const hostCallback = parent?.type === "CallExpression" && isRegistration(parent);
      const hook = typeName(parent?.id?.typeAnnotation?.typeAnnotation) === "Hook";
      if ((hostCallback || hook) && n.params[0] && !engineNames.has(n.params[0].name))
        report(n.params[0], "mods-api-alias", "hook engine parameters must use $ or _$");
      for (const p of n.params) if (engineNames.has(p.name)) parameters.add(p);
      if (n.id && typeName(n.params[0]?.typeAnnotation?.typeAnnotation) === "EngineInterface")
        helpers.add(n.id.name);
    }
  });
  const literal = (n) =>
    n?.type === "Literal" ? n.value : n?.type === "Identifier" ? values.get(n.name) : undefined;
  walk(program, (n) => {
    if (n.params) for (const p of n.params) if (p.name === "on") parameters.add(p);
  });
  for (const [name, count] of bindings) if (count > 1) helpers.delete(name);
  const context = { privileged, report, file, literal, parameters, helpers, typeName };
  walk(program, (n, parent) => {
    inspectDependency(n, context);
    inspectMember(n, parent, context);
    inspectIdentifier(n, parent, context);
  });
  return errors;
}
function isRegistration(call) {
  if (call?.type !== "CallExpression") return false;
  if (call.callee.name === "on") return true;
  return call.callee.type === "MemberExpression" && isRegistration(call.callee.object);
}
function inspectDependency(n, { file, privileged, literal, report }) {
  if (
    [
      "ImportDeclaration",
      "ExportNamedDeclaration",
      "ExportAllDeclaration",
      "ImportExpression",
      "TSImportType",
    ].includes(n.type)
  ) {
    const source = n.source ?? n.argument;
    if (!source) return;
    if (
      n.type === "ImportDeclaration" &&
      n.specifiers.some(
        (s) =>
          s.imported &&
          ["EngineInterface", "Hook"].includes(s.imported.name) &&
          s.local.name !== s.imported.name,
      )
    )
      report(n, "mods-api-alias", "host API types cannot be aliased");
    const target = literal(source);
    const local =
      typeof target === "string" &&
      target.startsWith(".") &&
      posix.normalize(posix.join(posix.dirname(file), target));
    const allowedLocal =
      local &&
      local.startsWith("plugins/cerberus-gate/hooks/") &&
      !local.endsWith(".d.ts") &&
      (privileged ||
        local.replace(/\.(?:[cm]?js|tsx?)$/u, "") !== registration.replace(/\.ts$/u, ""));
    if (!allowedLocal && !(privileged && target === "claude-code" && n.importKind === "type"))
      report(n, "dependency-boundary", `forbidden dependency ${target ?? "<dynamic>"}`);
  }
  if (
    n.type === "CallExpression" &&
    n.callee.type === "Identifier" &&
    ["require", "eval", "Function"].includes(n.callee.name)
  )
    report(n, "dependency-boundary", "indirect code loading is forbidden");
  if (n.type === "NewExpression" && n.callee.name === "Function")
    report(n, "dependency-boundary", "indirect code loading is forbidden");
}
function inspectMember(n, parent, { privileged, literal, report }) {
  if (n.type === "MemberExpression") {
    const parts = chain(n);
    if (!engineNames.has(parts[0])) return;
    if (parent?.type === "MemberExpression" && parent.object === n) return;
    const name = parts.slice(1).join(".");
    if (!privileged || !api.has(name) || parent?.type !== "CallExpression" || parent.callee !== n) {
      report(n, "mods-api", `forbidden or indirect API reference ${parts.join(".")}`);
      return;
    }
    if (["tool.call", "agent.register", "agent.spawn"].includes(name)) {
      const argument = parent.arguments[0];
      const key =
        name === "tool.call" ? "tool" : name === "agent.register" ? "name" : "subagentType";
      const expected =
        name === "tool.call"
          ? "TaskStop"
          : name === "agent.register"
            ? "reviewer"
            : "cerberus-gate:reviewer";
      const properties = argument?.type === "ObjectExpression" ? argument.properties : [];
      const fields = properties.filter((p) => !p.computed && (p.key?.name ?? p.key?.value) === key);
      if (
        properties.some((p) => p.type !== "Property" || p.computed) ||
        fields.length !== 1 ||
        literal(fields[0]?.value) !== expected
      )
        report(n, "mods-api-target", `${name} requires explicit ${key}: ${expected}`);
    }
  }
}
function inspectIdentifier(n, parent, { privileged, parameters, helpers, report, typeName }) {
  if (
    n.type === "Identifier" &&
    n.name === "on" &&
    !parameters.has(n) &&
    !(parent?.type === "CallExpression" && parent.callee === n)
  )
    report(n, "mods-api-alias", "hook registration must not be aliased");
  if (n.type === "Identifier" && engineNames.has(n.name)) {
    if (parameters.has(n) || (parent?.type === "MemberExpression" && parent.object === n)) return;
    if (
      privileged &&
      parent?.type === "CallExpression" &&
      parent.arguments[0] === n &&
      helpers.has(parent.callee.name)
    )
      return;
    report(
      n,
      "mods-api-alias",
      "engine references must be direct API calls or typed local helper arguments",
    );
  }
  if (
    n.type === "Identifier" &&
    typeName(n.typeAnnotation?.typeAnnotation) === "EngineInterface" &&
    !engineNames.has(n.name)
  )
    report(n, "mods-api-alias", "EngineInterface parameters must use $ or _$");
}
export async function check(root) {
  const files = (await sources(root, ["plugins"])).filter(
    ({ file }) => !file.includes("/tests/") && !file.includes(".test."),
  );
  if (!files.length) throw new Error("plugins:1: targets: no runtime sources");
  const errors = [];
  for (const { file, text } of files) {
    const imports = new Map();
    for (const n of parse(file, text).program.body) {
      if (n.type !== "ImportDeclaration" || !n.source.value.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), n.source.value));
      const dependency = files.find((f) => f.file === target);
      if (!dependency) continue;
      const values = constants(parse(target, dependency.text).program);
      for (const s of n.specifiers)
        if (s.type === "ImportSpecifier" && values.has(s.imported.name))
          imports.set(s.local.name, values.get(s.imported.name));
    }
    errors.push(...inspect(file, text, imports));
  }
  return errors;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await check(process.cwd());
  errors.forEach((e) => console.error(e));
  if (errors.length) process.exitCode = 1;
}
