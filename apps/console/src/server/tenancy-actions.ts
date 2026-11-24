import "@tanstack/react-start/server-only";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface CreateMutation<Scope> {
  readonly accessToken: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly scope: Scope;
}

export async function createOrganization({
  accessToken,
  body,
  idempotencyKey,
}: CreateMutation<unknown>): Promise<{ readonly id: string }> {
  const organization = await callRoute(
    "createOrganization",
    {
      body: decodeRequestBody("createOrganization", "CreateOrganizationRequest", body),
      idempotencyKey,
    },
    accessToken,
  );
  return { id: organization.id };
}

export async function createProject({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: CreateMutation<{ readonly organizationId: string }>): Promise<{
  readonly id: string;
  readonly name: string;
}> {
  const project = await callRoute(
    "createProject",
    {
      body: decodeRequestBody("createProject", "CreateProjectRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  return { id: project.id, name: project.name };
}

export async function createEnvironment({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: CreateMutation<{ readonly organizationId: string; readonly projectId: string }>): Promise<{
  readonly id: string;
}> {
  const environment = await callRoute(
    "createEnvironment",
    {
      body: decodeRequestBody("createEnvironment", "CreateEnvironmentRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  return { id: environment.id };
}
