import { describe, expect, test } from "bun:test";

import { awsSecretReferenceRegion, createModelRuntimeSecretValues } from "./runtime-secrets.ts";

describe("model runtime secrets", () => {
  test("stores trimmed API keys for hosted key-based providers only", () => {
    expect(
      createModelRuntimeSecretValues({
        hostedProviders: ["bedrock", "openai", "openrouter"],
        openAiApiKey: " sk-openai ",
        openRouterApiKey: "sk-or",
        operatorModelGrantsJson: "",
      }),
    ).toEqual({
      "model-grants-json": "[]",
      "openai-api-key": "sk-openai",
      "openrouter-api-key": "sk-or",
    });
    expect(
      createModelRuntimeSecretValues({ hostedProviders: ["bedrock"], operatorModelGrantsJson: "" }),
    ).toEqual({ "model-grants-json": "[]" });
  });

  test("requires each provider key exactly when its provider is hosted", () => {
    expect(() =>
      createModelRuntimeSecretValues({ hostedProviders: [], operatorModelGrantsJson: "" }),
    ).toThrow("At least one hosted model provider is required.");
    expect(() =>
      createModelRuntimeSecretValues({ hostedProviders: ["openai"], operatorModelGrantsJson: "" }),
    ).toThrow("An OpenAI API key is required exactly when the openai provider is hosted.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openai"],
        openAiApiKey: "  ",
        operatorModelGrantsJson: "",
      }),
    ).toThrow("An OpenAI API key is required exactly when the openai provider is hosted.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openrouter"],
        openAiApiKey: "sk-openai",
        openRouterApiKey: "sk-or",
        operatorModelGrantsJson: "",
      }),
    ).toThrow("An OpenAI API key is required exactly when the openai provider is hosted.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openrouter"],
        operatorModelGrantsJson: "",
      }),
    ).toThrow("An OpenRouter API key is required exactly when the openrouter provider is hosted.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["bedrock"],
        openRouterApiKey: "sk-or",
        operatorModelGrantsJson: "",
      }),
    ).toThrow("An OpenRouter API key is required exactly when the openrouter provider is hosted.");
  });

  test("validates grants against the hosted providers", () => {
    // Default providers (openai + openrouter) need only one of them hosted.
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openrouter"],
        openRouterApiKey: "sk-or",
        operatorModelGrantsJson: JSON.stringify([{ organizationId: "org_1" }]),
      }),
    ).not.toThrow();
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["bedrock"],
        operatorModelGrantsJson: JSON.stringify([{ organizationId: "org_1" }]),
      }),
    ).toThrow("Model grant 0 serves no hosted provider; list its providers.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openai"],
        openAiApiKey: "sk-openai",
        operatorModelGrantsJson: JSON.stringify([
          { organizationId: "org_1" },
          { organizationId: "org_1", providers: ["openai", "bedrock"] },
        ]),
      }),
    ).toThrow("Model grant 1 references provider bedrock, which is not hosted.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openai"],
        openAiApiKey: "sk-openai",
        operatorModelGrantsJson: JSON.stringify([{ organizationId: "org_1", value: "vk" }]),
      }),
    ).toThrow("Model grant 0 has unsupported field value.");
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openai"],
        openAiApiKey: "sk-openai",
        operatorModelGrantsJson: "{",
      }),
    ).toThrow();
  });

  test("stores grants canonically", () => {
    const values = createModelRuntimeSecretValues({
      hostedProviders: ["bedrock", "openai"],
      openAiApiKey: "sk-openai",
      operatorModelGrantsJson: JSON.stringify([
        {
          workspaceId: " ws_1 ",
          providers: ["bedrock", "bedrock"],
          organizationId: "org_1",
          allowedModels: ["bedrock/amazon.nova-micro-v1:0", "bedrock/amazon.nova-micro-v1:0"],
        },
        { agentId: "agent_1", providers: ["openai"] },
      ]),
    });
    expect(JSON.parse(values["model-grants-json"])).toEqual([
      {
        allowedModels: ["bedrock/amazon.nova-micro-v1:0"],
        organizationId: "org_1",
        providers: ["bedrock"],
        workspaceId: "ws_1",
      },
      { agentId: "agent_1", providers: ["openai"] },
    ]);
    expect(values["model-grants-json"]).toBe(
      '[{"allowedModels":["bedrock/amazon.nova-micro-v1:0"],"organizationId":"org_1","providers":["bedrock"],"workspaceId":"ws_1"},{"agentId":"agent_1","providers":["openai"]}]',
    );
  });

  test("accepts a deployment-wide grant for a hosted provider", () => {
    const grant =
      '{"organizationId":"*","providers":["openai"],"allowedModels":["openai/gpt-6-luna"]}';
    const values = createModelRuntimeSecretValues({
      hostedProviders: ["openai", "openrouter"],
      openAiApiKey: "sk-openai",
      openRouterApiKey: "sk-or",
      operatorModelGrantsJson: `[${grant}]`,
    });
    expect(values["model-grants-json"]).toBe(
      '[{"allowedModels":["openai/gpt-6-luna"],"organizationId":"*","providers":["openai"]}]',
    );
    expect(() =>
      createModelRuntimeSecretValues({
        hostedProviders: ["openai"],
        openAiApiKey: "sk-openai",
        operatorModelGrantsJson: '[{"organizationId":"*","workspaceId":"ws_1"}]',
      }),
    ).toThrow('Model grant 0 with organizationId "*" applies to every organization');
  });

  test("derives the Secrets Manager region from OpenTofu output ARNs", () => {
    expect(
      awsSecretReferenceRegion({
        first: "arn:aws:secretsmanager:us-east-2:123456789012:secret:first",
        second: "arn:aws:ssm:us-east-2:123456789012:parameter/models/model-grants-json",
      }),
    ).toBe("us-east-2");
    expect(() =>
      awsSecretReferenceRegion({
        first: "arn:aws:secretsmanager:us-east-1:123456789012:secret:first",
        second: "arn:aws:secretsmanager:us-west-2:123456789012:secret:second",
      }),
    ).toThrow("one AWS region");
  });
});
