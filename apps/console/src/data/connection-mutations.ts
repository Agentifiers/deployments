import type {
  CreateConnectionGrantRequest,
  CreateProviderCredentialRequest,
  RevokeAdministrationResourceRequest,
  RotateProviderCredentialRequest,
} from "@deployments-ai/api-contract/providers";
import type { CreateWorkspaceRequest } from "@deployments-ai/api-contract/tenancy";
import { createServerFn } from "@tanstack/react-start";
import type { PinStep } from "../connections/rebind.ts";
import {
  createConnection,
  createGrant,
  createWorkspace,
  pinDeployment,
  revokeConnection,
  revokeGrant,
  rotateCredential,
  verifyConnection,
} from "../server/connection-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  requireBody,
  requireIds,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

interface BodyInput<Body> extends KeyedInput {
  readonly body: Body;
}

/** Room for the `:<version>` suffix within the API's 512-character key limit. */
const MAX_KEY_PREFIX_LENGTH = 480;

function bodyInput<const Field extends string = never>(input: unknown, ids: readonly Field[] = []) {
  return { ...keyedInput(input, ids), body: requireBody(input) };
}

export const createConnectionFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateProviderCredentialRequest.Encoded>) => bodyInput(input))
  .handler(async ({ data }) =>
    createConnection({ ...data, accessToken: await requireAccessToken() }),
  );

export const rotateCredentialFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BodyInput<typeof RotateProviderCredentialRequest.Encoded> & {
        readonly connectionId: string;
      },
    ) => bodyInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    rotateCredential({ ...data, accessToken: await requireAccessToken() }),
  );

export const verifyConnectionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly connectionId: string }) =>
    keyedInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    verifyConnection({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeConnectionFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BodyInput<typeof RevokeAdministrationResourceRequest.Encoded> & {
        readonly connectionId: string;
      },
    ) => bodyInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    revokeConnection({ ...data, accessToken: await requireAccessToken() }),
  );

export const createGrantFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateConnectionGrantRequest.Encoded>) => bodyInput(input))
  .handler(async ({ data }) => createGrant({ ...data, accessToken: await requireAccessToken() }));

export const revokeGrantFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BodyInput<typeof RevokeAdministrationResourceRequest.Encoded> & {
        readonly grantId: string;
      },
    ) => bodyInput(input, ["grantId"]),
  )
  .handler(async ({ data }) => revokeGrant({ ...data, accessToken: await requireAccessToken() }));

export const createWorkspaceFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateWorkspaceRequest.Encoded>) => bodyInput(input))
  .handler(async ({ data }) =>
    createWorkspace({ ...data, accessToken: await requireAccessToken() }),
  );

export const pinDeploymentFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & Omit<PinStep, "kind">) => {
    const { keyPrefix, replacements } = fields(input);
    if (
      typeof keyPrefix !== "string" ||
      keyPrefix.length === 0 ||
      keyPrefix.length > MAX_KEY_PREFIX_LENGTH
    ) {
      throw new TypeError(
        `keyPrefix must be a non-empty string of at most ${MAX_KEY_PREFIX_LENGTH} characters.`,
      );
    }
    const pairs = Object.entries(fields(replacements)).map(([from, to]) => {
      const ids = requireIds({ from, to }, ["from", "to"]);
      return [ids.from, ids.to] as const;
    });
    return {
      ...scopedInput(input, ["deploymentId"]),
      keyPrefix,
      replacements: Object.fromEntries(pairs),
    };
  })
  .handler(async ({ data }) => pinDeployment({ ...data, accessToken: await requireAccessToken() }));
