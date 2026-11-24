import type { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  bffFenceRecord,
  makeOperatorAccessRepository,
  makeOrganizationEgressAllowlistReader,
  makeOrganizationStandingRepository,
  makePlatformPrincipalDirectory,
  makePrincipalCommandHandler,
  makePrincipalSecurityRepository,
  makePrincipalStatusRepository,
  OrganizationRecord,
  makeUniqueClaimRecord,
  securityStateRecord,
  uniqueClaimRequirements,
  UniqueClaimRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type Installation,
  type InstallationRepository,
  type PlatformOrganizationDirectory,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
import type { LambdaInvoker } from "../observability-erasure.ts";
import type { SystemOperatorConfiguration } from "./configuration.ts";
import { makeSystemOperatorAccess } from "./operator-access.ts";
import { makeSystemOrganizationSpend } from "./organization-spend.ts";
import { makeSystemOrganizationStanding } from "./organization-standing.ts";
import {
  PRINCIPAL_STATUS_FUNCTION_ENV,
  identityPrincipalStatus,
  makeSystemPrincipalStatus,
} from "./principal-status.ts";
import { identityPrincipalCommands, makeSystemPrincipals } from "./principals.ts";
import type { SystemAwsReaders } from "./readers.ts";
import { makeSystemOperatorService, type SystemOperatorRequest } from "./service.ts";

const decodeUniqueClaim = Schema.decodeUnknownSync(UniqueClaimRecord);

/** Platform identity's principal function, invoked the way Lambda delivers a payload. */
export function principalStatusFunction(
  database: DynamoDatabaseService,
  reissueVerification: Parameters<
    typeof makePrincipalCommandHandler
  >[0]["reissueVerification"] = async () => ({ outcome: "registration-closed" }),
): LambdaInvoker {
  const now = () => new Date("2026-10-01T12:00:00.000Z");
  const handler = makePrincipalCommandHandler({
    reissueVerification,
    security: makePrincipalSecurityRepository({ database, now }),
    statuses: makePrincipalStatusRepository({ database, now }),
  });
  return {
    send: async (command: InvokeCommand) => {
      const payload = JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array));
      return { Payload: Buffer.from(JSON.stringify(await handler(payload))) };
    },
  };
}

export const PRINCIPAL_STATUS_ENVIRONMENT = {
  [PRINCIPAL_STATUS_FUNCTION_ENV]: "identity-principal-status",
};

export const PERSON_ID = "01J0000000000000000000000P";

/** The records platform identity writes when a person finishes signing up. */
export function signedUpPerson(principalId: string) {
  const principal = Schema.decodeUnknownSync(Ulid)(principalId);
  const signedUpAt = "2026-09-01T00:00:00.000Z";
  return [
    humanPrincipalRecord(principal, `${principal.toLowerCase()}@example.test`),
    securityStateRecord({
      createdAt: signedUpAt,
      credentialVersion: 1,
      emailVerifiedAt: signedUpAt,
      principalId: principal,
      sessionEpoch: 0,
      version: 1,
    }),
    bffFenceRecord({
      createdAt: signedUpAt,
      principalId: principal,
      principalStatus: "active",
      sessionEpoch: 0,
      version: 1,
    }),
  ];
}

export const API_CODE_SHA256 = "a".repeat(64);

export const INSTALLATION = {
  awsAccountId: "123456789012",
  awsRegion: "us-east-2",
  createdAt: "2026-09-01T00:00:00.000Z",
  deployedAt: "2026-10-01T00:00:00.000Z",
  deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
  deploymentId: "01J00000000000000000000003",
  endpoints: [{ name: "platform-api", url: "https://api.example.com" }],
  id: "current",
  images: [
    {
      imageId: `sha256:${"b".repeat(64)}`,
      name: "durable-streams",
      uri: `123456789012.dkr.ecr.us-east-2.amazonaws.com/streams@sha256:${"c".repeat(64)}`,
    },
  ],
  lambdaArtifacts: [
    {
      functions: [
        { codeSha256: API_CODE_SHA256, name: "api" },
        { codeSha256: "0".repeat(64), name: "governance-worker" },
      ],
      name: "platform-api",
      sha256: "f".repeat(64),
    },
    {
      functions: [{ codeSha256: "e".repeat(64), name: "memory-api" }],
      name: "memory-runtime",
      sha256: "e".repeat(64),
    },
  ],
  profile: "platform-prod",
  releaseManifestSha256: "d".repeat(64),
  sourceCommit: "1".repeat(40),
  targetName: "acme-prod",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 3,
} as unknown as Installation;

export const CONFIGURATION: SystemOperatorConfiguration = {
  alarmNamePrefix: "acme-",
  ecsServices: [
    ["model-runtime", "models", "bifrost"],
    ["durable-streams", "durable-streams", "durable-streams"],
    ["agent-worker", "models", "agent-worker"],
  ],
  bedrockRegion: null,
  modelProviderSecrets: {
    openai: "arn:aws:ssm:us-east-2:123456789012:parameter/models/openai-api-key",
    openrouter: "arn:aws:secretsmanager:us-east-2:123456789012:secret:openrouter-AbCdEf",
  },
  observability: {
    athenaWorkgroup: "agent-observability",
    historyRetentionDays: 400,
    tableBucket: "agent-observability-tables",
    tableNamespace: "agent_observability",
  },
};

export function fakeReaders(overrides: Partial<SystemAwsReaders> = {}): SystemAwsReaders {
  return {
    describeAlarms: async () => ({ alarms: [] }),
    describeEcsServices: async () => new Map(),
    describeSecret: async () => undefined,
    listLambdaFunctions: async () => new Map(),
    ...overrides,
  };
}

export const TENANT_LIMIT_DEFAULTS = {
  activeSandboxes: 8,
  apiRequestBurst: 40,
  apiRequestsPerSecond: 20,
  concurrentRuns: 8,
} as const;

export const INSTALL_DEFAULTS = {
  operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
  tenantLimits: TENANT_LIMIT_DEFAULTS,
} as const;

export const OPERATOR_ID = "01J000000000000000000000P1";

export function operatorRequest(
  overrides: Partial<SystemOperatorRequest> = {},
): SystemOperatorRequest {
  return {
    body: undefined,
    caller: { kind: "operator", principalId: OPERATOR_ID },
    params: {},
    query: {},
    ...overrides,
  };
}

export function fakeService(
  input: {
    readonly configuration?: SystemOperatorConfiguration | undefined;
    readonly database?: DynamoDatabaseService;
    readonly installation?: Installation | undefined;
    readonly readers?: SystemAwsReaders;
  } = {},
) {
  const database =
    input.database ??
    evaluationMemoryDatabase([
      Schema.decodeUnknownSync(OrganizationRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "01J0000000000000000000000A",
            name: "Acme",
            slug: "acme",
            status: "active",
            updatedAt: "2026-01-02T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization" as const,
        }),
      ),
      ...signedUpPerson(PERSON_ID).flatMap((record) => [
        record,
        ...uniqueClaimRequirements(record).map((requirement) =>
          decodeUniqueClaim(makeUniqueClaimRecord(requirement, record.data.createdAt)),
        ),
      ]),
    ]).database;
  const installations: InstallationRepository = {
    current: async () => input.installation,
    listDeployments: async () => ({ items: [] }),
    recordDeployment: async () => {
      throw new Error("Operator routes never write installation records.");
    },
  };
  const organizations: PlatformOrganizationDirectory = {
    list: async () => ({
      items: [
        {
          activeMemberCount: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "01J0000000000000000000000A",
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      nextCursor: "next",
    }),
  };
  return makeSystemOperatorService({
    configuration: "configuration" in input ? input.configuration : CONFIGURATION,
    installations,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
    operatorAccess: makeSystemOperatorAccess(
      makeOperatorAccessRepository({
        database,
        now: () => new Date("2026-10-01T12:00:00.000Z"),
      }),
    ),
    organizationSpend: makeSystemOrganizationSpend({
      database,
      now: () => new Date("2026-10-01T12:00:00.000Z"),
    }),
    organizationStanding: makeSystemOrganizationStanding({
      egressAllowlist: makeOrganizationEgressAllowlistReader(database),
      installDefaults: INSTALL_DEFAULTS,
      standing: makeOrganizationStandingRepository({
        database,
        installDefaults: INSTALL_DEFAULTS,
        now: () => new Date("2026-10-01T12:00:00.000Z"),
      }),
    }),
    organizations,
    principalStatus: makeSystemPrincipalStatus(
      identityPrincipalStatus(PRINCIPAL_STATUS_ENVIRONMENT, principalStatusFunction(database)),
    ),
    principals: makeSystemPrincipals({
      directory: makePlatformPrincipalDirectory(database),
      identity: identityPrincipalCommands(
        PRINCIPAL_STATUS_ENVIRONMENT,
        principalStatusFunction(database, async (command) => ({
          email: command.email ?? "",
          outcome: "sent",
          principalId: command.principalId,
          sentAt: "2026-10-01T12:00:00.000Z",
        })),
      ),
    }),
    readers: input.readers ?? fakeReaders(),
  });
}
