import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const PARSER_LIBRARIES = ["fflate", "htmlparser2", "pdfjs-dist", "saxes"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function manifests() {
  const workspaces: readonly string[] = JSON.parse(readFileSync("package.json", "utf8")).workspaces;
  return [
    "package.json",
    ...workspaces.flatMap((pattern) => [
      ...new Bun.Glob(`${pattern}/package.json`).scanSync({ onlyFiles: true }),
    ]),
  ]
    .toSorted()
    .map((path) => {
      const manifest: Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>> =
        JSON.parse(readFileSync(path, "utf8"));
      return {
        path,
        dependencies: DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
      };
    });
}

function workspacesImporting(specifier: string) {
  const pattern = new RegExp(`from\\s+["']${specifier.replaceAll("/", "\\/")}["']`, "u");
  return [...new Bun.Glob("{apps,functions,packages}/**/*.{ts,tsx}").scanSync({ onlyFiles: true })]
    .filter((path) => !path.includes("/node_modules/") && pattern.test(readFileSync(path, "utf8")))
    .map((path) => path.split("/").slice(0, 2).join("/"))
    .filter((workspace, index, all) => all.indexOf(workspace) === index)
    .toSorted();
}

describe("document extraction boundary", () => {
  test("only the extraction function declares the parsers for untrusted files", () => {
    expect(
      manifests()
        .filter(({ dependencies }) => dependencies.some((name) => PARSER_LIBRARIES.includes(name)))
        .map(({ path }) => path),
    ).toEqual(["functions/document-extraction/package.json"]);
  });

  test("only the extraction function declares and imports Textract, so one caller reads scanned pages", () => {
    expect({
      declared: manifests()
        .filter(({ dependencies }) => dependencies.includes("@aws-sdk/client-textract"))
        .map(({ path }) => path),
      imported: workspacesImporting("@aws-sdk/client-textract"),
    }).toEqual({
      declared: ["functions/document-extraction/package.json"],
      imported: ["functions/document-extraction"],
    });
  });

  test("no workspace depends on the extraction function, so nothing imports its engine", () => {
    const functionPackage: string = JSON.parse(
      readFileSync("functions/document-extraction/package.json", "utf8"),
    ).name;
    expect({
      functionPackage,
      dependents: manifests()
        .filter(({ dependencies }) => dependencies.includes(functionPackage))
        .map(({ path }) => dirname(path)),
    }).toEqual({ functionPackage: "@deployments-ai/document-extraction", dependents: [] });
  });

  test("only the client and the function import the extraction wire format", () => {
    expect(workspacesImporting("@deployments-ai/file-text/wire")).toEqual([
      "functions/document-extraction",
    ]);
  });
});
