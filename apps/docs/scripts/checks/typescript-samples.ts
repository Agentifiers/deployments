import type { Code } from "mdast";
import type { OpenApiDocument } from "../reference/openapi-types.ts";
import type { NonEmpty } from "../reference/operations.ts";

type Extension = ".ts" | ".tsx";

const SAMPLE_EXTENSIONS: Readonly<Record<string, Extension>> = {
  ts: ".ts",
  tsx: ".tsx",
  typescript: ".ts",
};

export const CONTINUES_FENCE_META = "continues";

export type SampleOrigin =
  | { readonly kind: "operation"; readonly operationId: string }
  | {
      readonly kind: "page";
      readonly file: string;
      readonly firstLine: number;
      readonly fenceIndent: number;
    };

export interface Sample {
  readonly origin: SampleOrigin;
  readonly code: string;
}

export interface SampleModule {
  readonly extension: Extension;
  readonly samples: NonEmpty<Sample>;
}

export interface SamplePosition {
  readonly origin: SampleOrigin;
  readonly line: number;
  readonly column: number;
}

export type SampleProblem =
  | (SamplePosition & { readonly kind: "code"; readonly message: string })
  | {
      readonly kind: "fence";
      readonly origin: Extract<SampleOrigin, { kind: "page" }>;
      readonly message: string;
    };

export interface TscDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export function operationSampleModules(document: OpenApiDocument): SampleModule[] {
  return Object.values(document.paths).flatMap((pathItem) =>
    Object.values(pathItem).flatMap((operation) =>
      (operation["x-codeSamples"] ?? []).flatMap((codeSample): SampleModule[] => {
        const extension = SAMPLE_EXTENSIONS[codeSample.lang.toLowerCase()];
        if (!extension) return [];
        const origin = { kind: "operation", operationId: operation.operationId } as const;
        return [{ extension, samples: [{ origin, code: codeSample.source }] }];
      }),
    ),
  );
}

export function pageSampleModules(
  file: string,
  blocks: readonly Pick<Code, "lang" | "meta" | "position" | "value">[],
): { readonly modules: readonly SampleModule[]; readonly problems: readonly SampleProblem[] } {
  const modules: { extension: Extension; samples: [Sample, ...Sample[]] }[] = [];
  const problems: SampleProblem[] = [];
  for (const block of blocks) {
    const extension = SAMPLE_EXTENSIONS[(block.lang ?? "").toLowerCase()];
    if (!extension) continue;
    const start = block.position?.start ?? { line: 1, column: 1 };
    const origin = {
      kind: "page",
      file,
      firstLine: start.line + 1,
      fenceIndent: start.column - 1,
    } as const;
    const sample: Sample = { origin, code: block.value };
    const previous = modules.at(-1);
    const continues = (block.meta ?? "")
      .replaceAll(/"[^"]*"|'[^']*'/gu, "")
      .split(/\s+/u)
      .includes(CONTINUES_FENCE_META);
    if (!continues) {
      modules.push({ extension, samples: [sample] });
    } else if (previous) {
      previous.samples.push(sample);
      if (extension === ".tsx") previous.extension = ".tsx";
    } else {
      problems.push({
        kind: "fence",
        origin,
        message: `\`${CONTINUES_FENCE_META}\` needs an earlier TypeScript block on this page to continue.`,
      });
    }
  }
  return { modules, problems };
}

export function moduleSource(module: SampleModule): string {
  return module.samples.map((sample) => sample.code).join("\n");
}

export function locateInModule(module: SampleModule, line: number, column: number): SamplePosition {
  const [first, ...rest] = module.samples;
  let located = { sample: first, startLine: 1 };
  let nextStart = 1 + first.code.split("\n").length;
  for (const sample of rest) {
    if (line < nextStart) break;
    located = { sample, startLine: nextStart };
    nextStart += sample.code.split("\n").length;
  }
  return { origin: located.sample.origin, line: line - located.startLine + 1, column };
}

const DIAGNOSTIC = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/u;

export function parseTscOutput(output: string): {
  readonly diagnostics: readonly TscDiagnostic[];
  readonly unparsed: readonly string[];
} {
  const diagnostics: { file: string; line: number; column: number; message: string }[] = [];
  const unparsed: string[] = [];
  let open: { message: string } | undefined;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      const [, file = "", row = "", column = "", code = "", message = ""] = match;
      const diagnostic = {
        file,
        line: Number(row),
        column: Number(column),
        message: `${code}: ${message}`,
      };
      diagnostics.push(diagnostic);
      open = diagnostic;
    } else if (open && /^\s/u.test(line)) {
      open.message += `\n${line}`;
    } else {
      open = undefined;
      unparsed.push(line);
    }
  }
  return { diagnostics, unparsed };
}
