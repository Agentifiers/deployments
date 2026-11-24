import { readFile } from "node:fs/promises";
import {
  parseOperatorFundedModelSpendCeiling,
  type ModelSpendCeiling,
} from "@deployments-ai/tenant-limits/install-defaults";

const MODEL_GATEWAY_SERVICE_ENV = {
  bifrostUrl: "MODEL_GATEWAY_BIFROST_URL",
  bifrostVirtualKeyFile: "MODEL_GATEWAY_BIFROST_VIRTUAL_KEY_FILE",
  modelCredentialKmsKeyArn: "DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN",
  port: "PORT",
  stage: "DEPLOYMENTS_AI_STAGE",
  trustedSigningKeyArns: "MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS",
} as const;

const KMS_KEY_ARN_PATTERN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/u;

export interface ModelGatewayServiceConfiguration {
  readonly bifrostUrl: string;
  readonly bifrostVirtualKeyFile: string;
  /** The ceiling of an organization without a grant, the same one the token issuers apply. */
  readonly defaultModelSpendCeiling: ModelSpendCeiling;
  /**
   * The dedicated KMS key that seals organization provider keys and the stage bound into their
   * encryption context; absent when the install lets no organization use its own key.
   */
  readonly organizationKeys?: { readonly kmsKeyArn: string; readonly stage: string };
  readonly port: number;
  readonly trustedSigningKeyArns: readonly string[];
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function port(value: string | undefined) {
  if (!value?.trim()) return 8080;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${MODEL_GATEWAY_SERVICE_ENV.port} must be a positive TCP port.`);
  }
  return parsed;
}

function bifrostUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${MODEL_GATEWAY_SERVICE_ENV.bifrostUrl} must be an http URL.`);
  }
  if (url.protocol !== "http:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${MODEL_GATEWAY_SERVICE_ENV.bifrostUrl} must be an http origin.`);
  }
  return url.origin;
}

function trustedSigningKeyArns(value: string) {
  const arns = [
    ...new Set(
      value
        .split(",")
        .map((arn) => arn.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = arns.find((arn) => !KMS_KEY_ARN_PATTERN.test(arn));
  if (invalid !== undefined) {
    throw new Error(
      `${MODEL_GATEWAY_SERVICE_ENV.trustedSigningKeyArns} entries must be KMS key ARNs.`,
    );
  }
  if (arns.length === 0) {
    throw new Error(`${MODEL_GATEWAY_SERVICE_ENV.trustedSigningKeyArns} is required.`);
  }
  return arns;
}

function organizationKeys(environment: NodeJS.ProcessEnv) {
  const kmsKeyArn = environment[MODEL_GATEWAY_SERVICE_ENV.modelCredentialKmsKeyArn]?.trim();
  if (!kmsKeyArn) return undefined;
  if (!KMS_KEY_ARN_PATTERN.test(kmsKeyArn)) {
    throw new Error(`${MODEL_GATEWAY_SERVICE_ENV.modelCredentialKmsKeyArn} must be a KMS key ARN.`);
  }
  return { kmsKeyArn, stage: required(environment, MODEL_GATEWAY_SERVICE_ENV.stage) };
}

export function modelGatewayServiceConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ModelGatewayServiceConfiguration {
  const keys = organizationKeys(environment);
  return {
    bifrostUrl: bifrostUrl(required(environment, MODEL_GATEWAY_SERVICE_ENV.bifrostUrl)),
    bifrostVirtualKeyFile: required(environment, MODEL_GATEWAY_SERVICE_ENV.bifrostVirtualKeyFile),
    defaultModelSpendCeiling: parseOperatorFundedModelSpendCeiling(environment),
    ...(keys ? { organizationKeys: keys } : {}),
    port: port(environment[MODEL_GATEWAY_SERVICE_ENV.port]),
    trustedSigningKeyArns: trustedSigningKeyArns(
      required(environment, MODEL_GATEWAY_SERVICE_ENV.trustedSigningKeyArns),
    ),
  };
}

/** Reads the internal Bifrost virtual key the init container rendered; startup fails without it. */
export async function readBifrostVirtualKey(path: string) {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`The internal Bifrost virtual key file ${path} is unreadable.`, { cause });
  }
  const key = contents.trim();
  if (!key) throw new Error(`The internal Bifrost virtual key file ${path} is empty.`);
  return key;
}
