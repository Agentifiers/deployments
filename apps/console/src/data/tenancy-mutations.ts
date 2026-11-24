import type {
  CreateEnvironmentRequest,
  CreateOrganizationRequest,
  CreateProjectRequest,
} from "@deployments-ai/api-contract/tenancy";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import { createEnvironment, createOrganization, createProject } from "../server/tenancy-actions.ts";
import { keyedInputAt, requireBody, type KeyedInputAt, type ScopeLevel } from "./server-input.ts";

type CreateInput<Level extends ScopeLevel, Body> = KeyedInputAt<Level> & { readonly body: Body };

export const createOrganizationFn = createServerFn({ method: "POST" })
  .validator((input: CreateInput<"none", typeof CreateOrganizationRequest.Encoded>) => ({
    ...keyedInputAt("none", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createOrganization({ ...data, accessToken: await requireAccessToken() }),
  );

export const createProjectFn = createServerFn({ method: "POST" })
  .validator((input: CreateInput<"organization", typeof CreateProjectRequest.Encoded>) => ({
    ...keyedInputAt("organization", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createProject({ ...data, accessToken: await requireAccessToken() }));

export const createEnvironmentFn = createServerFn({ method: "POST" })
  .validator((input: CreateInput<"project", typeof CreateEnvironmentRequest.Encoded>) => ({
    ...keyedInputAt("project", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createEnvironment({ ...data, accessToken: await requireAccessToken() }),
  );
