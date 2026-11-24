import type { ActionSpec, CommandArgument, ContextScope } from "./types.ts";
export const positional = (description: string): CommandArgument => ({
  definition: { type: "positional", description, required: true },
  target: "path",
});

export const text = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "string", description },
  target,
});

export const requiredText = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "string", description, required: true },
  target,
});

export const flag = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "boolean", description },
  target,
});

export const negativeFlag = (
  description: string,
  field: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "boolean", description },
  field,
  target,
  transform: "negated-boolean",
});

export const nullFlag = (description: string, field: string): CommandArgument => ({
  definition: { type: "boolean", description },
  field,
  target: "body",
  transform: "null",
});

export const csv = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "string", description, valueHint: "a,b,c" },
  target,
  transform: "csv",
});

export const requiredCsv = (description: string): CommandArgument => ({
  definition: { type: "string", description, valueHint: "a,b,c", required: true },
  target: "body",
  transform: "csv",
});

export const repeatable = (description: string): CommandArgument => ({
  definition: { type: "string", description: `${description} (repeatable)` },
  repeatable: true,
  target: "body",
});

export const number = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "string", description, valueHint: "number" },
  target,
  transform: "number",
});

export const json = (
  description: string,
  target: CommandArgument["target"] = "body",
): CommandArgument => ({
  definition: { type: "string", description, valueHint: "json" },
  target,
  transform: "json",
});

export const requiredJson = (description: string): CommandArgument => ({
  definition: { type: "string", description, valueHint: "json", required: true },
  target: "body",
  transform: "json",
});

export const requiredNumber = (description: string): CommandArgument => ({
  definition: { type: "string", description, valueHint: "number", required: true },
  target: "body",
  transform: "number",
});

export const id = positional("Resource ID");
export const name = requiredText("Resource name");
export const description = text("Resource description");
export const reason = text("Reason for this operation");

export function action(spec: ActionSpec): ActionSpec {
  return spec;
}

export function sensitive(
  spec: ActionSpec,
  sensitiveOutputFields: readonly string[] = ["value", "key", "plaintext"],
): ActionSpec {
  return { ...spec, sensitiveOutput: true, sensitiveOutputFields };
}

export function list(
  path: string,
  scope: ContextScope,
  summary = "List resources",
  pagination?: ActionSpec["pagination"],
): ActionSpec {
  return action({
    summary,
    method: "GET",
    path,
    scope,
    output: "list",
    ...(pagination ? { pagination } : {}),
  });
}

export function show(path: string, scope: ContextScope, summary = "Show a resource"): ActionSpec {
  return action({
    summary,
    method: "GET",
    path: `${path}/:id`,
    scope,
    output: "detail",
    args: { id },
  });
}

export function create(
  path: string,
  scope: ContextScope,
  args: Readonly<Record<string, CommandArgument>> = { name, description },
  summary = "Create a resource",
): ActionSpec {
  return action({ summary, method: "POST", path, scope, output: "detail", args, idempotent: true });
}

export function mutate(
  method: ActionSpec["method"],
  path: string,
  scope: ContextScope,
  summary: string,
  args: Readonly<Record<string, CommandArgument>> = { id, reason },
  destructive = method === "DELETE",
): ActionSpec {
  return action({
    summary,
    method,
    path: `${path}/:id`,
    scope,
    output: "action",
    args,
    idempotent: true,
    destructive,
  });
}

export function lifecycleAction(
  path: string,
  operation: string,
  scope: ContextScope,
  summary: string,
  args: Readonly<Record<string, CommandArgument>>,
  destructive = false,
): ActionSpec {
  return action({
    summary,
    method: "POST",
    path: `${path}/:id/${operation}`,
    scope,
    output: "action",
    args,
    idempotent: true,
    destructive,
  });
}
