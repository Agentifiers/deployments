import { PublicId } from "@deployments-ai/api-contract/primitives";
import {
  ConnectionCapabilityResponse,
  ConnectionGrantResponse,
  ProviderConnectionResponse,
} from "@deployments-ai/api-contract/providers";
import { Schema } from "effect";
import type {
  CapabilityView,
  ConnectionView,
  GrantView,
  PinningDeploymentView,
} from "./connection-state.ts";
import type { RebindObservation, RotateSearch } from "./rebind.ts";

export const SINCE = "2026-09-10T12:00:00.000Z";
export const JUST_BEFORE = "2026-09-10T11:59:59.999Z";
export const AFTER = "2026-09-10T12:05:00.000Z";
export const ROTATE: RotateSearch = { kind: "rotate", since: SINCE };

export const publicId = (label: string) =>
  Schema.decodeUnknownSync(PublicId)(`01K${label.padStart(23, "0")}`);

export const X = publicId("X");
export const WS = publicId("WS");
export const WS2 = publicId("WS2");
export const WS3 = publicId("WS3");
export const D1 = publicId("D1");
export const D2 = publicId("D2");
export const D4 = publicId("D4");

export function connection(
  status: string,
  scopes: readonly string[] = ["account:read"],
): ConnectionView {
  return Schema.decodeUnknownSync(ProviderConnectionResponse)({
    authMethod: "static",
    createdAt: "2026-09-01T00:00:00.000Z",
    displayName: "QA demio",
    hasCredential: true,
    id: X,
    providerKey: "demio",
    scopes,
    status,
    updatedAt: SINCE,
    version: 4,
  });
}

export function grant(
  id: string,
  status: "active" | "revoked",
  {
    createdAt = "2026-09-02T00:00:00.000Z",
    scopes = ["account:read"],
    updatedAt = SINCE,
    workspaceId = WS,
  } = {},
): GrantView {
  return Schema.decodeUnknownSync(ConnectionGrantResponse)({
    authorizationVersion: 1,
    connectionId: X,
    createdAt,
    externalAccountId: "acct",
    externalResourceConstraints: { region: "us" },
    id,
    providerKey: "demio",
    purpose: "agent-runtime",
    scopes,
    status,
    updatedAt,
    version: 2,
    workspaceId,
  });
}

export function deployment(
  id: PublicId,
  pins: Readonly<Record<string, string>>,
  states: Pick<PinningDeploymentView, "currentState" | "desiredState"> = {
    currentState: "ready",
    desiredState: "running",
  },
): PinningDeploymentView {
  return {
    agentDefinitionId: publicId("DEF"),
    id,
    runtimeConfig: {
      apiVersion: "agents.deployments.ai/v1",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: Object.fromEntries(
        Object.entries(pins).map(([tool, authorizationId]) => [tool, { authorizationId }]),
      ),
    },
    version: 7,
    ...states,
  };
}

export const ACTIVE_CAPABILITY: CapabilityView = Schema.decodeUnknownSync(
  ConnectionCapabilityResponse,
)({
  connectionId: X,
  id: publicId("CAP"),
  providerKey: "demio",
  scopes: ["account:read"],
  status: "active",
  verificationVersion: 2,
});

export const G1 = grant(publicId("G1"), "revoked");
export const G2 = grant(publicId("G2"), "revoked", {
  createdAt: "2026-09-03T00:00:00.000Z",
  workspaceId: WS2,
});
export const G3 = grant(publicId("G3"), "revoked", { updatedAt: JUST_BEFORE, workspaceId: WS3 });
export const R1 = grant(publicId("R1"), "active", { createdAt: AFTER, updatedAt: AFTER });
export const R2 = grant(publicId("R2"), "active", {
  createdAt: "2026-09-10T12:06:00.000Z",
  updatedAt: AFTER,
  workspaceId: WS2,
});
export const STOPPED = deployment(
  publicId("D3"),
  { a: G1.id },
  { currentState: "stopped", desiredState: "stopped" },
);

export function observe(
  overrides: Partial<RebindObservation> & Pick<RebindObservation, "deployments" | "grants">,
): RebindObservation {
  const target = connection("active");
  return {
    now: AFTER,
    old: target,
    target,
    targetCapabilities: [ACTIVE_CAPABILITY],
    ...overrides,
  };
}
