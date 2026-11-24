import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockAt, terraformFilesUnder } from "./terraform-files.ts";

function blocks(path: string, opener: RegExp) {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(opener)].map((match) => ({
    name: match[1] ?? "",
    body: blockAt(source, match.index),
  }));
}

test("bounds every IAM role a module creates except the vendor-account registry publisher", () => {
  const unbounded = terraformFilesUnder("infrastructure/modules").flatMap((path) =>
    blocks(path, /^resource "aws_iam_role" "([^"]+)" \{/gmu)
      .filter(
        ({ body }) =>
          !/^ {2}permissions_boundary\s*=.*\bvar\.permissions_boundary_arn\b/mu.test(body),
      )
      .map(({ name }) => `${path} ${name}`),
  );

  expect(unbounded).toEqual(["infrastructure/modules/release-registry/main.tf publisher"]);
});

test("passes the stack's boundary to every module the stack calls that creates IAM roles", () => {
  const stack = "infrastructure/modules/platform";
  const roleModuleCalls = readdirSync(stack)
    .filter((file) => file.endsWith(".tf"))
    .flatMap((file) => blocks(join(stack, file), /^module "([^"]+)" \{/gmu))
    .filter(({ body }) =>
      terraformFilesUnder(join(stack, /source\s*=\s*"([^"]+)"/u.exec(body)?.[1] ?? "")).some(
        (path) => /^resource "aws_iam_role" /mu.test(readFileSync(path, "utf8")),
      ),
    );

  expect(roleModuleCalls.map(({ name }) => name)).toContain("platform_api");
  expect(
    roleModuleCalls
      .filter(
        ({ body }) =>
          !/^ {2}permissions_boundary_arn\s*=\s*var\.iam_permissions_boundary_arn$/mu.test(body),
      )
      .map(({ name }) => name),
  ).toEqual([]);
});
