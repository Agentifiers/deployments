import { invokeLambda } from "./lambda-invoke.ts";
import { type CommandRunner, log } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

/** The memory then Brain default search activation functions the applied root reports. */
export function searchPlacementFunctions(outputs: TerraformOutputs): readonly string[] {
  const value = outputs.search_placement_functions;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const functions = value as Readonly<Record<string, unknown>>;
  // Memory first: Brain activation reuses each organization's active memory embedding profile.
  return ["memory", "brain"].flatMap((runtime) => {
    const name = functions[runtime];
    return typeof name === "string" && name ? [name] : [];
  });
}

/** One install-wide page from a search placement function. */
export interface SearchPlacementPage {
  readonly failed: readonly string[];
  readonly nextCursor?: string;
  readonly results: readonly { readonly organizationId: string; readonly outcome: string }[];
}

export type SearchPlacementInvoker = (
  functionName: string,
  payload: { readonly cursor?: string; readonly organizations: "all" },
) => Promise<SearchPlacementPage>;

/**
 * Activates the default search placement of every organization on the install, one page per
 * invocation. The functions change only organizations that are still unconfigured, so every
 * deploy can run this; a page with failed organizations fails the deploy.
 */
export async function activateSearchPlacements(input: {
  readonly functions: readonly string[];
  readonly invoke: SearchPlacementInvoker;
}) {
  for (const functionName of input.functions) {
    const outcomes: Record<string, number> = {};
    let cursor: string | undefined;
    do {
      const page = await input.invoke(functionName, {
        ...(cursor ? { cursor } : {}),
        organizations: "all",
      });
      if (page.failed.length > 0) {
        throw new Error(
          `${functionName} could not activate search for organizations ${page.failed.join(", ")}; see its CloudWatch logs.`,
        );
      }
      for (const result of page.results) {
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const summary = Object.entries(outcomes)
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(", ");
    log(`${functionName}: ${summary || "no organizations"}`);
  }
}

function searchPlacementPage(functionName: string, value: unknown): SearchPlacementPage {
  if (value === null || typeof value !== "object") {
    throw new Error(`${functionName} returned no activation page.`);
  }
  const page = value as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(page.failed) ||
    !Array.isArray(page.results) ||
    (page.nextCursor !== undefined && typeof page.nextCursor !== "string")
  ) {
    throw new Error(`${functionName} returned a malformed activation page.`);
  }
  return {
    failed: page.failed.map(String),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    results: page.results.map((result) => {
      const entry = result as Readonly<Record<string, unknown>>;
      return { organizationId: String(entry.organizationId), outcome: String(entry.outcome) };
    }),
  };
}

/** Invokes a search placement function synchronously through the AWS CLI. */
export function cliSearchPlacementInvoker(run: CommandRunner): SearchPlacementInvoker {
  return async (functionName, payload) =>
    searchPlacementPage(functionName, await invokeLambda(run, functionName, payload));
}
