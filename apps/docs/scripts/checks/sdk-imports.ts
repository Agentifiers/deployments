import type { DocsManifest } from "../reference/manifest.ts";
import type { CodeProblem } from "./cli-usage.ts";

const SDK_IMPORT =
  /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@deployments-ai\/sdk["']/gu;

export function sdkImportProblems(code: string, manifest: DocsManifest): CodeProblem[] {
  const exported = new Set([...manifest.sdk.functions, ...manifest.sdk.runtimeExports]);
  const problems: CodeProblem[] = [];
  for (const match of code.matchAll(SDK_IMPORT)) {
    const specifiers = match[1] ?? "";
    const specifiersStart = match.index + match[0].indexOf("{") + 1;
    let offset = 0;
    for (const specifier of specifiers.split(",")) {
      const name = specifier
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name && !exported.has(name)) {
        const line = code
          .slice(0, specifiersStart + offset + specifier.indexOf(name))
          .split("\n").length;
        problems.push({
          line,
          message: `@agentifiers/deployments-sdk exports no \`${name}\`. Use an operation function from the SDK function reference or one of: ${manifest.sdk.runtimeExports.join(", ")}.`,
        });
      }
      offset += specifier.length + 1;
    }
  }
  return problems;
}
