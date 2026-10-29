import type { Node, Program, CallExpression, ObjectPropertyKind } from "oxc-parser";
interface Context {
  file: string;
  privileged: boolean;
  literal: (node: Node | null | undefined) => unknown;
  report: (node: Node, rule: string, message: string) => void;
  parameters: Set<Node>;
  helpers: Set<string>;
  typeName: (node: Node | undefined) => string | undefined;
  readCalls: Set<Node>;
  allowedApi: ReadonlySet<string>;
}
import { resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnostic, parse, sources, walk } from "./source.ts";

function nodeName(node: Node | null | undefined): string | undefined {
  return node?.type === "Identifier" ? node.name : undefined;
}
function annotationOf(node: Node | null | undefined): Node | undefined {
  return node && "typeAnnotation" in node && node.typeAnnotation?.type === "TSTypeAnnotation"
    ? node.typeAnnotation.typeAnnotation
    : undefined;
}
const registration = "plugins/cerberus-gate/hooks/register.ts";
// The review loop holds the reviewer API calls under the same API rules as registration.
const reviewLoop = "plugins/cerberus-gate/hooks/review-loop.ts";
const reviewLoopApi = new Set([
  "clock.now",
  "model.complete",
  "session.cwd",
  "tool.call",
  "tool.list",
]);
const displayRegistration = "plugins/cerberus-gate-display/hooks/register.ts";
const api = new Set([
  "agent.list",
  "agent.register",
  "agent.spawn",
  "clock.now",
  "clock.after",
  "command.register",
  "config.set",
  "ui.open",
  "ui.close",
  "ui.resolve",
  "prompt.submit",
  "process.run",
  "plugin.root",
  "session.version",
  "session.id",
  "session.cwd",
  "state.get",
  "state.set",
  "tool.list",
  "tool.call",
  "ui.status",
  "ui.toast",
  "ui.log",
  "model.complete",
  "turn.abort",
]);
const engineNames = new Set(["$", "_$"]);
function chain(node: Node | null | undefined): string[] {
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression") return [];
  return [...chain(node.object), node.computed ? "<computed>" : node.property.name];
}
function constants(program: Program) {
  const values = new Map<string, unknown>();
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
// One named boundary may forward model-selected session tools; all other calls need static targets.
function member(node: Node | null | undefined, object: string, property: string) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    nodeName(node.object) === object &&
    node.property.name === property
  );
}
function sessionGuard(guard: Node | undefined) {
  if (guard?.type !== "IfStatement") return false;
  const test = guard.test,
    deny = guard.consequent;
  return (
    guard?.type === "IfStatement" &&
    test?.type === "UnaryExpression" &&
    test.operator === "!" &&
    test.argument.type === "CallExpression" &&
    member(test.argument.callee, "tools", "has") &&
    member(test.argument.arguments[0], "call", "tool") &&
    deny?.type === "ReturnStatement" &&
    deny.argument?.type === "ObjectExpression" &&
    deny.argument.properties.some(
      (p) =>
        p.type === "Property" &&
        nodeName(p.key) === "deny" &&
        p.value?.type === "Literal" &&
        typeof p.value.value === "string",
    )
  );
}
function readCall(expression: Node | undefined) {
  if (expression?.type !== "CallExpression" || chain(expression.callee).join(".") !== "$.tool.call")
    return false;
  let arg = expression.arguments[0];
  while (arg?.type === "TSAsExpression") arg = arg.expression;
  if (arg?.type !== "ObjectExpression" || arg.properties.length !== 2) return false;
  const [spread, tool] = arg.properties;
  return (
    spread?.type === "SpreadElement" &&
    member(spread.argument, "call", "input") &&
    tool?.type === "Property" &&
    !tool.computed &&
    nodeName(tool.key) === "tool" &&
    member(tool.value, "call", "tool")
  );
}
function guardedReadCalls(program: Program) {
  const approved = new Set<Node>();
  walk(program, (fn) => {
    if (
      fn.type !== "FunctionDeclaration" ||
      fn.id?.name !== "callReviewTool" ||
      nodeName(fn.params[0]) !== "$" ||
      nodeName(fn.params[1]) !== "call" ||
      nodeName(fn.params[2]) !== "tools"
    )
      return;
    if (!fn.body) return;
    const [guard, result] = fn.body.body;
    if (
      sessionGuard(guard) &&
      result?.type === "ReturnStatement" &&
      result.argument?.type === "CallExpression" &&
      readCall(result.argument)
    )
      approved.add(result.argument.callee);
  });
  return approved;
}
export function inspect(
  file: string,
  text: string,
  importedConstants: Map<string, unknown> = new Map(),
) {
  const { program } = parse(file, text);
  const errors: string[] = [];
  const report: Context["report"] = (n, rule, message) =>
    errors.push(diagnostic(file, text, n, rule, message));
  const privileged = file === registration || file === reviewLoop;
  const values = new Map([...importedConstants, ...constants(program)]);
  const bindings = new Map<string, number>();
  const bind = (id: Node | null | undefined) =>
    walk(id, (n) => {
      if (n.type === "Identifier") bindings.set(n.name, (bindings.get(n.name) ?? 0) + 1);
    });
  walk(program, (n) => {
    if (n.type === "VariableDeclarator") bind(n.id);
    if ("params" in n) n.params.forEach(bind);
    if (n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") bind(n.id);
    if (n.type === "CatchClause") bind(n.param);
    if ("local" in n && n.local) bind(n.local);
  });
  for (const [name, count] of bindings) if (count > 1) values.delete(name);
  const aliases = new Map<string, Node>();
  walk(program, (n) => {
    if (n.type === "TSTypeAliasDeclaration") aliases.set(n.id.name, n.typeAnnotation);
  });
  const typeName = (annotation: Node | undefined): string | undefined => {
    let name = annotation?.type === "TSTypeReference" ? nodeName(annotation.typeName) : undefined;
    const seen = new Set();
    while (name !== undefined && aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      const alias = aliases.get(name);
      name = alias?.type === "TSTypeReference" ? nodeName(alias.typeName) : undefined;
    }
    return name;
  };
  const helpers = new Set<string>();
  const parameters = new Set<Node>();
  walk(program, (n, parent) => {
    if ("params" in n) {
      const hostCallback = parent?.type === "CallExpression" && isRegistration(parent);
      const hook =
        typeName(parent && "id" in parent ? annotationOf(parent.id) : undefined) === "Hook";
      if ((hostCallback || hook) && n.params[0] && !engineNames.has(nodeName(n.params[0]) ?? ""))
        report(n.params[0], "mods-api-alias", "hook engine parameters must use $ or _$");
      for (const p of n.params) if (engineNames.has(nodeName(p) ?? "")) parameters.add(p);
      if ("id" in n && n.id && typeName(annotationOf(n.params[0])) === "EngineInterface")
        helpers.add(n.id.name);
    }
  });
  const literal: Context["literal"] = (n) =>
    n?.type === "Literal" ? n.value : n?.type === "Identifier" ? values.get(n.name) : undefined;
  walk(program, (n) => {
    if ("params" in n) for (const p of n.params) if (nodeName(p) === "on") parameters.add(p);
  });
  // Registration may pass the engine to the review loop exports, which are checked in their own file.
  if (file === registration)
    walk(program, (n) => {
      if (n.type === "ImportDeclaration" && literal(n.source) === "./review-loop.ts")
        for (const s of n.specifiers) if (s.type === "ImportSpecifier") helpers.add(s.local.name);
    });
  for (const [name, count] of bindings) if (count > 1) helpers.delete(name);
  const context: Context = {
    privileged,
    report,
    file,
    literal,
    parameters,
    helpers,
    typeName,
    readCalls: guardedReadCalls(program),
    allowedApi: file === reviewLoop ? reviewLoopApi : api,
  };
  walk(program, (n, parent) => {
    inspectDependency(n, context);
    inspectMember(n, parent, context);
    inspectIdentifier(n, parent, context);
  });
  return errors;
}
function isRegistration(call: Node | undefined): boolean {
  if (call?.type !== "CallExpression") return false;
  if (nodeName(call.callee) === "on") return true;
  return call.callee.type === "MemberExpression" && isRegistration(call.callee.object);
}
function inspectDependency(n: Node, { file, privileged, literal, report }: Context) {
  if (
    n.type === "ImportDeclaration" ||
    n.type === "ExportNamedDeclaration" ||
    n.type === "ExportAllDeclaration" ||
    n.type === "ImportExpression" ||
    n.type === "TSImportType"
  ) {
    const source = n.source;
    if (!source) return;
    if (
      n.type === "ImportDeclaration" &&
      n.specifiers.some(
        (s) =>
          s.type === "ImportSpecifier" &&
          ["EngineInterface", "Hook"].includes(nodeName(s.imported) ?? "") &&
          s.local.name !== nodeName(s.imported),
      )
    )
      report(n, "mods-api-alias", "host API types cannot be aliased");
    const target = literal(source);
    const local =
      typeof target === "string" &&
      target.startsWith(".") &&
      posix.normalize(posix.join(posix.dirname(file), target));
    const allowedLocal =
      file !== displayRegistration &&
      local &&
      !local.endsWith("/session-log.mts") &&
      (!local.endsWith("/debug-log.mts") ||
        file === "plugins/cerberus-gate/hooks/session-log.mts") &&
      local.startsWith("plugins/cerberus-gate/hooks/") &&
      !local.endsWith(".d.ts") &&
      (file === registration ||
        local.replace(/\.(?:[cm]?[jt]s|tsx)$/u, "") !== registration.replace(/\.ts$/u, ""));
    const hostTypes =
      (privileged || file === displayRegistration) &&
      target === "claude-code" &&
      n.type === "ImportDeclaration" &&
      n.importKind === "type";
    const helperImports: Record<string, string[]> = {
      "node:fs/promises": [
        "open",
        "mkdtemp",
        "writeFile",
        "unlink",
        "rmdir",
        "realpath",
        "readdir",
        "lstat",
      ],
      "node:os": ["tmpdir", "homedir"],
      "node:path": ["join", "dirname", "basename"],
      "node:url": ["fileURLToPath"],
    };
    const debugImports: Record<string, string[]> = {
      "node:fs/promises": ["open", "mkdir", "lstat", "realpath"],
      "node:fs": ["constants"],
      "node:os": ["homedir"],
      "node:path": ["join", "resolve", "parse"],
      "node:url": ["fileURLToPath"],
    };
    const imports =
      file === "plugins/cerberus-gate/hooks/debug-log.mts" ? debugImports : helperImports;
    const helper =
      [
        "plugins/cerberus-gate/hooks/session-log.mts",
        "plugins/cerberus-gate/hooks/debug-log.mts",
      ].includes(file) &&
      n.type === "ImportDeclaration" &&
      typeof target === "string" &&
      imports[target] &&
      n.specifiers.every(
        (s) =>
          s.type === "ImportSpecifier" &&
          s.local.name === nodeName(s.imported) &&
          imports[target]!.includes(nodeName(s.imported) ?? ""),
      );
    const ownManifest =
      file === "plugins/cerberus-gate/hooks/debug-log.mts" &&
      n.type === "ImportDeclaration" &&
      target === "../.claude-plugin/plugin.json";
    if (!allowedLocal && !hostTypes && !helper && !ownManifest)
      report(
        n,
        "dependency-boundary",
        `forbidden dependency ${typeof target === "string" ? target : "<dynamic>"}`,
      );
  }
  if (
    n.type === "CallExpression" &&
    n.callee.type === "Identifier" &&
    ["require", "eval", "Function"].includes(n.callee.name)
  )
    report(n, "dependency-boundary", "indirect code loading is forbidden");
  if (n.type === "NewExpression" && nodeName(n.callee) === "Function")
    report(n, "dependency-boundary", "indirect code loading is forbidden");
}
function inspectProcess(
  n: Node,
  parent: CallExpression,
  literal: Context["literal"],
  report: Context["report"],
) {
  const argv = parent.arguments[0];
  const args = argv?.type === "ArrayExpression" ? argv.elements : [];
  const helper = args[1];
  if (
    args.length !== 3 ||
    literal(args[0]) !== "node" ||
    !(
      (helper?.type === "TemplateLiteral" &&
        helper.quasis[1]?.value.cooked === "/hooks/session-log.mts" &&
        ["create", "release"].some((operation) => operation === literal(args[2]))) ||
      (helper?.type === "TemplateLiteral" &&
        helper.quasis[1]?.value.cooked === "/hooks/debug-log.mts" &&
        ["initialize", "append"].some((operation) => operation === literal(args[2])))
    ) ||
    helper?.type !== "TemplateLiteral" ||
    helper.expressions.length !== 1 ||
    chain(helper.expressions[0]).join(".") !== "$.plugin.root" ||
    helper.quasis[0]?.value.cooked !== "" ||
    !["/hooks/session-log.mts", "/hooks/debug-log.mts"].includes(helper.quasis[1]?.value.cooked)
  )
    report(n, "mods-api-target", "process.run permits only bundled material/debug operations");
  const options = parent.arguments[1];
  if (
    options?.type !== "ObjectExpression" ||
    options.properties.some(
      (p) =>
        p.type !== "Property" ||
        p.computed ||
        !["stdin", "timeoutMs"].includes(nodeName(p.key) ?? ""),
    )
  )
    report(n, "mods-api-target", "bundled helpers permit only stdin and timeoutMs");
}
function propertyKey(property: ObjectPropertyKind): unknown {
  return property.type === "Property"
    ? (nodeName(property.key) ?? (property.key.type === "Literal" ? property.key.value : undefined))
    : undefined;
}
function inspectMember(
  n: Node,
  parent: Node | undefined,
  { privileged, literal, report, readCalls, allowedApi }: Context,
) {
  if (n.type === "MemberExpression") {
    const parts = chain(n);
    if (!engineNames.has(parts[0] ?? "")) return;
    if (parent?.type === "MemberExpression" && parent.object === n) return;
    const name = parts.slice(1).join(".");
    if (
      !privileged ||
      !allowedApi.has(name) ||
      (name !== "plugin.root" && (parent?.type !== "CallExpression" || parent.callee !== n))
    ) {
      report(n, "mods-api", `forbidden or indirect API reference ${parts.join(".")}`);
      return;
    }
    if (name === "plugin.root") return;
    if (parent?.type !== "CallExpression") return;
    if (name === "process.run") inspectProcess(n, parent, literal, report);
    if (name === "config.set") {
      const argument = parent.arguments[0];
      const properties = argument?.type === "ObjectExpression" ? argument.properties : [];
      const keys = properties.filter((p) => propertyKey(p) === "key");
      if (
        properties.some((p) => p.type !== "Property" || p.computed) ||
        keys.length !== 1 ||
        ![
          "cerberus-gate.reviewerModel",
          "cerberus-gate.reviewerEffort",
          "cerberus-gate.enabled",
          "cerberus-gate.language",
        ].some((key) => key === literal(keys[0]?.type === "Property" ? keys[0].value : undefined))
      )
        report(
          n,
          "mods-api-target",
          "config.set requires an enabled, reviewer model, effort or language setting",
        );
    }
    if (name === "tool.call" && readCalls.has(n)) return;
    if (name === "state.get" || name === "state.set")
      inspectState(n, parent, name, literal, report);
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
      const fields = properties.filter(
        (p) => p.type === "Property" && !p.computed && propertyKey(p) === key,
      );
      if (
        properties.some((p) => p.type !== "Property" || p.computed) ||
        fields.length !== 1 ||
        literal(fields[0]?.type === "Property" ? fields[0].value : undefined) !== expected
      )
        report(n, "mods-api-target", `${name} requires explicit ${key}: ${expected}`);
    }
  }
}
function inspectIdentifier(
  n: Node,
  parent: Node | undefined,
  { privileged, parameters, helpers, report, typeName }: Context,
) {
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
      helpers.has(nodeName(parent.callee) ?? "")
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
    typeName(annotationOf(n)) === "EngineInterface" &&
    !engineNames.has(n.name)
  )
    report(n, "mods-api-alias", "EngineInterface parameters must use $ or _$");
}
export async function check(root: string) {
  const files = (await sources(root, ["plugins"])).filter(
    ({ file }) => !file.includes("/tests/") && !file.includes(".test."),
  );
  if (!files.length) throw new Error("plugins:1: targets: no runtime sources");
  const errors: string[] = [];
  for (const { file, text } of files) {
    const imports = new Map<string, unknown>();
    for (const n of parse(file, text).program.body) {
      if (n.type !== "ImportDeclaration" || !n.source.value.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), n.source.value));
      const dependency = files.find((f) => f.file === target);
      if (!dependency) continue;
      const values = constants(parse(target, dependency.text).program);
      for (const s of n.specifiers)
        if (
          s.type === "ImportSpecifier" &&
          s.imported.type === "Identifier" &&
          values.has(s.imported.name)
        )
          imports.set(s.local.name, values.get(s.imported.name));
    }
    errors.push(...inspect(file, text, imports));
  }
  return errors;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const errors = await check(process.cwd());
  errors.forEach((e) => console.error(e));
  if (errors.length) process.exitCode = 1;
}

function inspectState(
  n: Node,
  parent: CallExpression,
  name: string,
  literal: Context["literal"],
  report: Context["report"],
) {
  const argument = parent.arguments[0];
  const properties = argument?.type === "ObjectExpression" ? argument.properties : [];
  const expected = { plugin: "cerberus-gate", key: "recovery" };
  if (
    properties.length !== 2 ||
    properties.some((p) => p.type !== "Property" || p.computed) ||
    Object.entries(expected).some(([key, value]) => {
      const fields = properties.filter((p) => propertyKey(p) === key);
      return (
        fields.length !== 1 ||
        literal(fields[0]?.type === "Property" ? fields[0].value : undefined) !== value
      );
    })
  )
    report(n, "mods-api-target", `${name} requires the cerberus-gate recovery state`);
}
