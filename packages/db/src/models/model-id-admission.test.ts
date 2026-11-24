import { describe, expect, test } from "bun:test";
import type { ModelOperatorGrant } from "@deployments-ai/model-gateway";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeModelIdAdmission } from "./model-id-admission.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
};
const LUNA = "openai/gpt-6-luna";

const emptyDatabase: DynamoDatabaseService = {
  deleteRecord: () => Promise.reject(new Error("unused")),
  getRecord: async () => undefined,
  putRecord: () => Promise.reject(new Error("unused")),
  queryRecords: () => Promise.reject(new Error("unused")),
  transactWrite: () => Promise.reject(new Error("unused")),
};

function admitWith(grants: readonly ModelOperatorGrant[]) {
  return makeModelIdAdmission(emptyDatabase, async () => grants)(scope, LUNA);
}

describe("model id admission", () => {
  test("admits a judge model an organization grant lists", async () => {
    expect(
      await admitWith([
        { allowedModels: [LUNA], organizationId: scope.organizationId, providers: ["openai"] },
      ]),
    ).toEqual({ allowed: true, basis: "operator-grant", curated: false, modelId: LUNA });
  });

  test("admits a judge model a deployment-wide grant lists", async () => {
    expect(
      await admitWith([{ allowedModels: [LUNA], organizationId: "*", providers: ["openai"] }]),
    ).toMatchObject({ allowed: true, basis: "operator-grant", modelId: LUNA });
  });

  test("ignores agent and workspace grants, which a judge call never matches", async () => {
    expect(
      await admitWith([
        { agentId: "01ARZ3NDEKTSV4RRFFQ69G5FA4", allowedModels: [LUNA] },
        { allowedModels: [LUNA], workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA5" },
      ]),
    ).toMatchObject({
      allowed: false,
      modelId: LUNA,
      reason: "model_not_allowed_by_environment_policy",
    });
    expect(await makeModelIdAdmission(emptyDatabase)(scope, LUNA)).toMatchObject({
      allowed: false,
      modelId: LUNA,
      reason: "model_not_allowed_by_environment_policy",
    });
  });
});
