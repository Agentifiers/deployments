import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { noVerification, sandboxDefinition } from "./shared.ts";

/** Sandbox-only tool route; the pinned dependency owns execution and customer auth is absent. */
export const SANDBOX_TOOL_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    sandboxDefinition({
      key: "hyperframes",
      displayName: "Hyperframes",
      category: "video",
      supportsMultipleAccounts: false,
      status: "planned",
      verification: noVerification(
        "Sandbox execution only: use pinned hyperframes 0.7.64 under the run-scoped sandbox lease with no customer credential, account binding, or live provider verification.",
      ),
      tools: Object.freeze(["hyperframes.render"]),
    }),
  ]);
