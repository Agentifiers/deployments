import { describe, expect, test } from "bun:test";
import {
  modelRuntimeHostedProviders,
  modelRuntimeRestartRequired,
  operatorModelGrantsJson,
} from "./model-runtime-secrets.ts";

describe("model runtime parameter synchronization", () => {
  test("reads hosted providers from the applied root", () => {
    expect(
      modelRuntimeHostedProviders({ model_runtime_hosted_providers: ["bedrock", "openrouter"] }),
    ).toEqual(["bedrock", "openrouter"]);
    for (const value of [undefined, null, [], ["azure"], "openai"]) {
      expect(() => modelRuntimeHostedProviders({ model_runtime_hosted_providers: value })).toThrow(
        "model_runtime_hosted_providers",
      );
    }
  });

  test("takes grants from the environment, else keeps the stored grants, else seeds none", () => {
    const configured = JSON.stringify([{ organizationId: "org_a", providers: ["openai"] }]);
    const stored = JSON.stringify([{ organizationId: "org_b", providers: ["openai"] }]);

    expect(operatorModelGrantsJson({ DEPLOYMENTS_AI_MODEL_GRANTS_JSON: configured }, stored)).toBe(
      configured,
    );
    expect(operatorModelGrantsJson({ DEPLOYMENTS_AI_MODEL_GRANTS_JSON: "  " }, stored)).toBe(
      stored,
    );
    expect(operatorModelGrantsJson({}, undefined)).toBe("[]");
  });

  test("rolls the gateway only when a provider key changed", () => {
    expect(modelRuntimeRestartRequired(["model-grants-json"])).toBe(false);
    expect(modelRuntimeRestartRequired(["model-grants-json", "openrouter-api-key"])).toBe(true);
    expect(modelRuntimeRestartRequired(["openai-api-key"])).toBe(true);
    expect(modelRuntimeRestartRequired([])).toBe(false);
  });
});
