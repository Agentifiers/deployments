import type {
  CreateAgentEmailDomainRequest,
  CreateAgentEmailPlacementRequest,
  CreateAgentEmailSuppressionRequest,
  UpdateAgentEmailPlacementRequest,
  UpdateAgentEmailPolicyRequest,
} from "@deployments-ai/api-contract/agent-email";
import { createServerFn } from "@tanstack/react-start";
import {
  createDomain,
  createPlacement,
  createSuppression,
  refreshDomain,
  removeSuppression,
  revokeDomain,
  updatePlacement,
  updatePolicy,
} from "../server/agent-email-setup-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

type Body<Schema extends { readonly Encoded: unknown }> = KeyedInput & {
  readonly body: Schema["Encoded"];
};

function bodyInput<const Field extends string = never>(input: unknown, ids: readonly Field[] = []) {
  return { ...keyedInput(input, ids), body: requireBody(input) };
}

export const createDomainFn = createServerFn({ method: "POST" })
  .validator((input: Body<typeof CreateAgentEmailDomainRequest>) => bodyInput(input))
  .handler(async ({ data }) => createDomain({ ...data, accessToken: await requireAccessToken() }));

export const refreshDomainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly domainId: string }) => keyedInput(input, ["domainId"]))
  .handler(async ({ data }) => refreshDomain({ ...data, accessToken: await requireAccessToken() }));

export const revokeDomainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly domainId: string }) => keyedInput(input, ["domainId"]))
  .handler(async ({ data }) => revokeDomain({ ...data, accessToken: await requireAccessToken() }));

export const createPlacementFn = createServerFn({ method: "POST" })
  .validator((input: Body<typeof CreateAgentEmailPlacementRequest>) => bodyInput(input))
  .handler(async ({ data }) =>
    createPlacement({ ...data, accessToken: await requireAccessToken() }),
  );

export const updatePlacementFn = createServerFn({ method: "POST" })
  .validator(
    (input: Body<typeof UpdateAgentEmailPlacementRequest> & { readonly placementId: string }) =>
      bodyInput(input, ["placementId"]),
  )
  .handler(async ({ data }) =>
    updatePlacement({ ...data, accessToken: await requireAccessToken() }),
  );

export const updatePolicyFn = createServerFn({ method: "POST" })
  .validator((input: Body<typeof UpdateAgentEmailPolicyRequest>) => bodyInput(input))
  .handler(async ({ data }) => updatePolicy({ ...data, accessToken: await requireAccessToken() }));

export const createSuppressionFn = createServerFn({ method: "POST" })
  .validator((input: Body<typeof CreateAgentEmailSuppressionRequest>) => bodyInput(input))
  .handler(async ({ data }) =>
    createSuppression({ ...data, accessToken: await requireAccessToken() }),
  );

export const removeSuppressionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly suppressionId: string }) =>
    keyedInput(input, ["suppressionId"]),
  )
  .handler(async ({ data }) =>
    removeSuppression({ ...data, accessToken: await requireAccessToken() }),
  );
