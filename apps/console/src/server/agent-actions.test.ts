import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { deploymentUpdateBody } from "./agent-actions.ts";

describe("deploymentUpdateBody", () => {
  test("passes a retarget, pause, or resume through", () => {
    expect(deploymentUpdateBody({ desiredState: "paused", expectedVersion: 3 })).toEqual({
      desiredState: "paused",
      expectedVersion: 3,
    });
  });

  test("refuses a runtime config, which only the tool bindings editor writes", () => {
    const update = () =>
      deploymentUpdateBody({
        expectedVersion: 3,
        runtimeConfig: { apiVersion: "agents.deployments.ai/v1", kind: "AgentDeploymentConfig" },
      });
    expect(update).toThrow(PlatformApiError);
    expect(update).toThrow(
      "Change a deployment's runtime configuration through its tool bindings editor.",
    );
  });
});
