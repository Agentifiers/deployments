import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type IdentityRecord,
  makeDynamoDatabase,
  makeIdentityRepository,
  oauthClientRecord,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import {
  PLATFORM_CLI_SCOPES,
  randomToken,
  sha256,
  SUPPORTED_OAUTH_SCOPES,
} from "@deployments-ai/identity";
import { declaredOAuthClients, type DeclaredOAuthClient } from "./declared-identity-clients.ts";
import { log } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

interface BootstrapContext {
  readonly now: string;
  readonly parameters: SSMClient;
  readonly repository: ReturnType<typeof makeIdentityRepository>;
}

/** The `platform_identity_bootstrap` OpenTofu output, decoded. */
export interface IdentityBootstrap {
  readonly additionalClients: readonly DeclaredOAuthClient[];
  readonly bootstrapRoleArn: string;
  readonly cliRedirectUris: readonly string[];
  readonly completionMarkerName: string;
  readonly e2eClientSecretArn: string | undefined;
  readonly publicationReady: boolean;
  readonly webClientSecretArn: string;
  readonly webRedirectUris: readonly string[];
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OpenTofu output platform_identity_bootstrap.${name} is required.`);
  }
  return value.trim();
}

function textArray(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry)) {
    throw new Error(
      `OpenTofu output platform_identity_bootstrap.${name} must be an array of non-empty strings.`,
    );
  }
  return value as readonly string[];
}

/** Returns the identity bootstrap contract, or undefined when the root does not enable identity. */
export function identityBootstrap(outputs: TerraformOutputs): IdentityBootstrap | undefined {
  const value = outputs.platform_identity_bootstrap;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenTofu output platform_identity_bootstrap must be an object.");
  }
  const field = (name: string): unknown => Reflect.get(value, name);
  const e2eSecret = field("e2e_client_secret_arn");
  return {
    additionalClients: declaredOAuthClients(field("additional_clients")),
    bootstrapRoleArn: requiredText(field("bootstrap_role_arn"), "bootstrap_role_arn"),
    cliRedirectUris: textArray(field("cli_redirect_uris"), "cli_redirect_uris"),
    completionMarkerName: requiredText(field("completion_marker_name"), "completion_marker_name"),
    e2eClientSecretArn:
      typeof e2eSecret === "string" && e2eSecret.trim() ? e2eSecret.trim() : undefined,
    publicationReady: field("publication_ready") === true,
    webClientSecretArn: requiredText(field("web_client_secret_arn"), "web_client_secret_arn"),
    webRedirectUris: textArray(field("web_redirect_uris"), "web_redirect_uris"),
  };
}

export interface AppsOAuthClient {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly secretArn: string;
}

export function appsOAuthClient(outputs: TerraformOutputs): AppsOAuthClient | undefined {
  const runtime = outputs.app_runtime;
  if (runtime === null || runtime === undefined) return undefined;
  if (typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("OpenTofu output app_runtime must be an object.");
  }
  const client: unknown = Reflect.get(runtime, "oauth_client");
  if (client === null || client === undefined) return undefined;
  if (typeof client !== "object" || Array.isArray(client)) {
    throw new Error("OpenTofu output app_runtime.oauth_client must be an object.");
  }
  const field = (name: string) => {
    const value: unknown = Reflect.get(client, name);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`OpenTofu output app_runtime.oauth_client.${name} is required.`);
    }
    return value.trim();
  };
  return {
    clientId: field("client_id"),
    redirectUri: field("redirect_uri"),
    secretArn: field("secret_arn"),
  };
}

function identityTableEnvironment(outputs: TerraformOutputs) {
  const tables = outputs.dynamodb_table_names;
  if (tables === null || typeof tables !== "object") {
    throw new Error("OpenTofu output dynamodb_table_names is required for identity bootstrap.");
  }
  const table = (name: string) => {
    const tableName: unknown = Reflect.get(tables, name);
    if (typeof tableName !== "string" || !tableName) {
      throw new Error(`OpenTofu output dynamodb_table_names.${name} is required.`);
    }
    return tableName;
  };
  return {
    DEPLOYMENTS_AI_CONTROL_TABLE: table("control"),
    DEPLOYMENTS_AI_EVENTS_TABLE: table("events"),
    DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE: table("identity-email-outbox"),
    DEPLOYMENTS_AI_IDENTITY_TABLE: table("identity"),
  };
}

/** The parameter name in a Parameter Store ARN; PutParameter does not accept the ARN. */
export function parameterName(arn: string) {
  const match = /^arn:aws[a-z-]*:ssm:[a-z0-9-]+:\d{12}:parameter(\/.+)$/u.exec(arn);
  if (!match?.[1]) throw new Error(`${arn} is not a Parameter Store parameter ARN.`);
  return match[1];
}

/**
 * Whether the client needs a new secret. These secrets do not rotate: a parameter whose value
 * matches the recorded hash keeps it, so copying a value in from another store changes nothing.
 */
export function needsNewClientSecret(input: {
  readonly parameterValue: string | undefined;
  readonly recordedHash: string | undefined;
}) {
  return (
    !input.parameterValue ||
    !input.recordedHash ||
    sha256(input.parameterValue) !== input.recordedHash
  );
}

async function readParameter(context: BootstrapContext, name: string) {
  try {
    const result = await context.parameters.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return result.Parameter?.Value?.trim() || undefined;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "name" in cause) {
      if (cause.name === "ParameterNotFound") return undefined;
    }
    throw cause;
  }
}

async function upsertPublicClient(context: BootstrapContext, redirectUris: readonly string[]) {
  const current = await context.repository.clientForId("deployments-cli");
  const next = oauthClientRecord({
    allowedScopes: PLATFORM_CLI_SCOPES,
    clientId: "deployments-cli",
    createdAt: current?.data.createdAt ?? context.now,
    grantTypes: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    name: "Deployments CLI",
    redirectUris,
    requiredScopes: [],
    tokenEndpointAuthMethod: "none",
    type: "public",
    version: (current?.data.version ?? 0) + 1,
  });
  await context.repository.transact([
    current
      ? { kind: "put", previousRecord: current, record: next }
      : { kind: "put", record: next },
  ]);
}

async function ensureConfidentialClient(
  context: BootstrapContext,
  input: {
    readonly allowedScopes: readonly string[];
    readonly clientId: string;
    readonly name: string;
    readonly redirectUris: readonly string[];
    readonly requiredScopes: readonly string[];
    readonly secretArn: string;
  },
) {
  const name = parameterName(input.secretArn);
  const current = await context.repository.clientForId(input.clientId);
  const recordedHash = current?.data.clientSecretHash;
  const parameterValue = await readParameter(context, name);
  let rawSecret = needsNewClientSecret({ parameterValue, recordedHash })
    ? randomToken()
    : undefined;
  try {
    const clientSecretHash = rawSecret ? sha256(rawSecret) : recordedHash;
    if (!clientSecretHash) throw new Error(`${input.name} client secret material is unavailable.`);
    const next = oauthClientRecord({
      allowedScopes: input.allowedScopes,
      clientId: input.clientId,
      clientSecretHash,
      createdAt: current?.data.createdAt ?? context.now,
      grantTypes: ["authorization_code", "refresh_token"],
      name: input.name,
      redirectUris: input.redirectUris,
      requiredScopes: input.requiredScopes,
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: (current?.data.version ?? 0) + 1,
    });
    // A new secret keeps the hash of the value readers hold valid for a day, so a reader that
    // cached it keeps signing in until it rereads the parameter. After a run that wrote the
    // record but not the parameter, readers still hold the older, previous value.
    const liveHash = parameterValue ? sha256(parameterValue) : undefined;
    const replacedHash =
      liveHash && liveHash === current?.data.previousClientSecretHash ? liveHash : recordedHash;
    const previous =
      rawSecret && replacedHash
        ? {
            previousClientSecretHash: replacedHash,
            previousSecretExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }
        : {
            ...(current?.data.previousClientSecretHash
              ? { previousClientSecretHash: current.data.previousClientSecretHash }
              : {}),
            ...(current?.data.previousSecretExpiresAt
              ? { previousSecretExpiresAt: current.data.previousSecretExpiresAt }
              : {}),
          };
    const persisted = { ...next, data: { ...next.data, ...previous, updatedAt: context.now } };
    // The record accepts the new secret before any reader can see it in the parameter.
    await context.repository.transact([
      current
        ? { kind: "put", previousRecord: current, record: persisted }
        : { kind: "put", record: persisted },
    ]);
    if (rawSecret) {
      await context.parameters.send(
        new PutParameterCommand({
          Name: name,
          Overwrite: true,
          Type: "SecureString",
          Value: rawSecret,
        }),
      );
    }
  } finally {
    rawSecret = undefined;
  }
}

function activeConfidentialClient(client: IdentityRecord<"oauth-client"> | undefined) {
  return (
    client?.data.status === "active" &&
    Boolean(client.data.clientSecretHash) &&
    client.data.grantTypes.includes("authorization_code")
  );
}

/**
 * Upserts the public CLI client and the confidential web (and optional E2E,
 * apps, and operator-declared) clients, generating a client secret only where
 * its parameter is missing or does not match the record, validates every
 * client, and records the completion marker. Runs under the root's dedicated
 * bootstrap role.
 */
export async function bootstrapIdentityClients(input: {
  readonly bootstrap: IdentityBootstrap;
  /** Deployment name; part of the bootstrap role session name. */
  readonly name: string;
  readonly outputs: TerraformOutputs;
  readonly region: string;
}) {
  const { bootstrap } = input;
  const appsClient = appsOAuthClient(input.outputs);
  const tableEnvironment = identityTableEnvironment(input.outputs);
  const assumed = await new STSClient({ region: input.region }).send(
    new AssumeRoleCommand({
      RoleArn: bootstrap.bootstrapRoleArn,
      RoleSessionName: `identity-client-bootstrap-${input.name}`,
    }),
  );
  const accessKeyId = assumed.Credentials?.AccessKeyId;
  const secretAccessKey = assumed.Credentials?.SecretAccessKey;
  const sessionToken = assumed.Credentials?.SessionToken;
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("STS returned no identity bootstrap credentials.");
  }
  const clientConfiguration = {
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    region: input.region,
  };
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient(clientConfiguration), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(tableEnvironment),
  );
  const repository = makeIdentityRepository(database);
  const ssm = new SSMClient(clientConfiguration);
  const context: BootstrapContext = {
    now: new Date().toISOString(),
    parameters: ssm,
    repository,
  };
  const webSecretId = bootstrap.webClientSecretArn;
  const e2eSecretId = bootstrap.e2eClientSecretArn;

  await upsertPublicClient(context, bootstrap.cliRedirectUris);
  await ensureConfidentialClient(context, {
    allowedScopes: SUPPORTED_OAUTH_SCOPES,
    clientId: "deployments-web",
    name: "Deployments Web",
    redirectUris: bootstrap.webRedirectUris,
    requiredScopes: ["openid"],
    secretArn: webSecretId,
  });
  if (e2eSecretId) {
    await ensureConfidentialClient(context, {
      allowedScopes: ["managed-skills:admin", "managed-skills:read", "memory:execute", "openid"],
      clientId: "deployments-e2e",
      name: "Deployments E2E",
      redirectUris: bootstrap.webRedirectUris,
      requiredScopes: ["openid"],
      secretArn: e2eSecretId,
    });
  }
  if (appsClient) {
    await ensureConfidentialClient(context, {
      allowedScopes: ["email", "openid", "profile"],
      clientId: appsClient.clientId,
      name: "Deployments Apps",
      redirectUris: [appsClient.redirectUri],
      requiredScopes: ["openid"],
      secretArn: appsClient.secretArn,
    });
  }
  for (const client of bootstrap.additionalClients) {
    await ensureConfidentialClient(context, { ...client, requiredScopes: ["openid"] });
  }

  const [publicClient, webClient, e2eClient, appsRecord, declaredRecords] = await Promise.all([
    repository.clientForId("deployments-cli"),
    repository.clientForId("deployments-web"),
    e2eSecretId ? repository.clientForId("deployments-e2e") : Promise.resolve(undefined),
    appsClient ? repository.clientForId(appsClient.clientId) : Promise.resolve(undefined),
    Promise.all(
      bootstrap.additionalClients.map(({ clientId }) => repository.clientForId(clientId)),
    ),
  ]);
  if (
    publicClient?.data.status !== "active" ||
    !publicClient.data.grantTypes.includes("urn:ietf:params:oauth:grant-type:device_code") ||
    !activeConfidentialClient(webClient) ||
    (e2eSecretId && !activeConfidentialClient(e2eClient)) ||
    (appsClient && !activeConfidentialClient(appsRecord)) ||
    !declaredRecords.every(activeConfidentialClient)
  ) {
    throw new Error("OAuth client bootstrap validation failed.");
  }
  await ssm.send(
    new PutParameterCommand({
      Name: bootstrap.completionMarkerName,
      Overwrite: true,
      Type: "String",
      Value: webSecretId,
    }),
  );
  log("Bootstrapped and validated identity OAuth clients.");
}
