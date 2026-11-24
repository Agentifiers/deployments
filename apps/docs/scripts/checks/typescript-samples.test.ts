import { describe, expect, it } from "bun:test";
import {
  locateInModule,
  moduleSource,
  operationSampleModules,
  pageSampleModules,
  parseTscOutput,
} from "./typescript-samples.ts";

function block(lang: string, meta: string | null, value: string, line: number, column = 1) {
  return {
    lang,
    meta,
    value,
    position: { start: { line, column }, end: { line: line + 2, column: column + 3 } },
  };
}

describe("pageSampleModules", () => {
  it("appends a continues block to the previous TypeScript block and skips other languages", () => {
    expect(
      pageSampleModules("page.mdx", [
        block("ts", null, "const a = 1;", 5),
        block("bash", null, "deployments health", 9),
        block("ts", 'title="a.ts" continues', "a;", 13, 3),
        block("ts", 'title="continues"', "const b = 2;", 17),
      ]),
    ).toEqual({
      modules: [
        {
          extension: ".ts",
          samples: [
            {
              origin: { kind: "page", file: "page.mdx", firstLine: 6, fenceIndent: 0 },
              code: "const a = 1;",
            },
            {
              origin: { kind: "page", file: "page.mdx", firstLine: 14, fenceIndent: 2 },
              code: "a;",
            },
          ],
        },
        {
          extension: ".ts",
          samples: [
            {
              origin: { kind: "page", file: "page.mdx", firstLine: 18, fenceIndent: 0 },
              code: "const b = 2;",
            },
          ],
        },
      ],
      problems: [],
    });
  });

  it("reports a continues block with nothing before it and compiles a chain with TSX as TSX", () => {
    expect(
      pageSampleModules("page.mdx", [
        block("ts", "continues", "orphan;", 3),
        block("ts", null, "const x = 1;", 7),
        block("tsx", "continues", "<p>{x}</p>;", 11),
      ]),
    ).toEqual({
      modules: [
        {
          extension: ".tsx",
          samples: [
            {
              origin: { kind: "page", file: "page.mdx", firstLine: 8, fenceIndent: 0 },
              code: "const x = 1;",
            },
            {
              origin: { kind: "page", file: "page.mdx", firstLine: 12, fenceIndent: 0 },
              code: "<p>{x}</p>;",
            },
          ],
        },
      ],
      problems: [
        {
          kind: "fence",
          origin: { kind: "page", file: "page.mdx", firstLine: 4, fenceIndent: 0 },
          message: "`continues` needs an earlier TypeScript block on this page to continue.",
        },
      ],
    });
  });
});

describe("locateInModule", () => {
  const first = { origin: { kind: "operation", operationId: "first" }, code: "a\nb" } as const;
  const second = { origin: { kind: "operation", operationId: "second" }, code: "c\nd\ne" } as const;
  const module = { extension: ".ts", samples: [first, second] } as const;

  it("maps module lines back to the sample that holds them", () => {
    expect(moduleSource(module)).toBe("a\nb\nc\nd\ne");
    expect(locateInModule(module, 2, 4)).toEqual({ origin: first.origin, line: 2, column: 4 });
    expect(locateInModule(module, 4, 2)).toEqual({ origin: second.origin, line: 2, column: 2 });
  });
});

describe("parseTscOutput", () => {
  it("joins elaboration lines and keeps unlocated errors", () => {
    expect(
      parseTscOutput(
        [
          "sample-1.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
          "  Type 'null' is not assignable to type 'number'.",
          "error TS5023: Unknown compiler option 'bogus'.",
          "/tmp/x/sample-2.tsx(1,1): error TS2304: Cannot find name 'y'.",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      diagnostics: [
        {
          file: "sample-1.ts",
          line: 3,
          column: 5,
          message:
            "TS2322: Type 'string' is not assignable to type 'number'.\n  Type 'null' is not assignable to type 'number'.",
        },
        {
          file: "/tmp/x/sample-2.tsx",
          line: 1,
          column: 1,
          message: "TS2304: Cannot find name 'y'.",
        },
      ],
      unparsed: ["error TS5023: Unknown compiler option 'bogus'."],
    });
  });
});

describe("operationSampleModules", () => {
  it("takes the TypeScript code samples of every operation", () => {
    expect(
      operationSampleModules({
        openapi: "3.1.0",
        info: { title: "API", version: "1" },
        paths: {
          "/health": {
            get: {
              operationId: "getHealth",
              "x-codeSamples": [
                { lang: "ts", label: "TypeScript SDK", source: "await getHealth();\n" },
                { lang: "bash", label: "CLI", source: "deployments health\n" },
              ],
            },
          },
        },
        components: { schemas: {}, securitySchemes: {} },
      }),
    ).toEqual([
      {
        extension: ".ts",
        samples: [
          { origin: { kind: "operation", operationId: "getHealth" }, code: "await getHealth();\n" },
        ],
      },
    ]);
  });
});
