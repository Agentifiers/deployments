import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockAt, terraformFilesUnder } from "./terraform-files.ts";

function quotedList(bootstrapRoot: string, local: string) {
  const source = readFileSync(join(bootstrapRoot, "main.tf"), "utf8");
  return [
    ...(new RegExp(`${local}\\s*=\\s*\\[([^\\]]*)\\]`, "u").exec(source)?.[1] ?? "").matchAll(
      /"([^"]+)"/gu,
    ),
  ].map((match) => match[1] ?? "");
}

const customer = "infrastructure/bootstrap/customer";
const customerPrefixes = quotedList(customer, "workload_name_prefixes").map((prefix) =>
  prefix.replaceAll("${var.environment_name}", "dev"),
);
const customerRoleNames = quotedList(customer, "workload_role_names");

test("ends every customer deploy role prefix in a hyphen", () => {
  expect(customerPrefixes).not.toEqual([]);
  expect(customerPrefixes.filter((prefix) => !prefix.endsWith("-"))).toEqual([]);
});

const moduleLocals = new Map<string, Map<string, string>>();
for (const path of terraformFilesUnder("infrastructure/modules")) {
  const source = readFileSync(path, "utf8");
  const locals = moduleLocals.get(dirname(path)) ?? new Map<string, string>();
  for (const match of source.matchAll(/^locals \{/gmu)) {
    for (const [, name = "", value = ""] of blockAt(source, match.index).matchAll(
      /^ {2}(\w+)\s*=\s*"([^"$]*)"$/gmu,
    )) {
      locals.set(name, value);
    }
  }
  moduleLocals.set(dirname(path), locals);
}

function resolve(expression: string, locals: Map<string, string>) {
  const template = /^"(.*)"$/u.exec(expression)?.[1] ?? `\${${expression}}`;
  const resolved = template.replaceAll(
    /\$\{local\.(\w+)\}/gu,
    (reference, name: string) => locals.get(name) ?? reference,
  );
  return resolved.includes("${") ? null : resolved;
}

const iamNames = terraformFilesUnder("infrastructure/modules").flatMap((path) => {
  const source = readFileSync(path, "utf8");
  return [
    ...source.matchAll(/^resource "(aws_iam_role|aws_iam_policy|aws_iam_instance_profile)" /gmu),
  ].flatMap((match) => {
    const [, attribute = "", expression = ""] =
      /^ {2}(name|name_prefix)\s*=\s*(.+)$/mu.exec(blockAt(source, match.index)) ?? [];
    const name = resolve(expression, moduleLocals.get(dirname(path)) ?? new Map());
    if (name === null) return [];
    return [{ type: match[1] ?? "", generated: attribute === "name_prefix", name, path }];
  });
});

test("names every statically known module IAM name inside the customer deploy role's names", () => {
  expect(iamNames.map(({ name }) => name)).toContain("api");
  expect(
    iamNames.filter(
      ({ type, generated, name }) =>
        !customerPrefixes.some((prefix) => name.startsWith(prefix)) &&
        !(type === "aws_iam_role" && !generated && customerRoleNames.includes(name)),
    ),
  ).toEqual([]);
});
