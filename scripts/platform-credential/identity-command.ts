import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeIdentityRepository,
  makeIdGenerator,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import {
  DEFAULT_PASSWORD_PROFILE,
  hashPassword,
  verifyPasswordEqualized,
} from "@deployments-ai/identity";
import type { CliCommand } from "./cli.ts";
import { operatorIdentityChange, operatorIdentityOperations } from "./identity-plan.ts";
import { generateOperatorPassword, passwordSecretAction } from "./password-source.ts";
import { type SecretStore, writeSecret } from "./secrets.ts";

export interface IdentityResult {
  readonly outcome: "created" | "rotated" | "unchanged";
  readonly principalId: string;
  readonly secretArn?: string;
}

/** Resolves the password; with a secret, a generated password reaches the secret first. */
async function operatorPassword(
  command: Extract<CliCommand, { readonly kind: "identity" }>,
  secrets: () => SecretStore,
) {
  const source = command.password;
  if (source.kind === "environment") return { password: source.password, secretArn: undefined };
  const store = secrets();
  const secret = await store.read(source.secretId);
  const action = passwordSecretAction({
    rotate: command.rotate,
    secret,
    secretId: source.secretId,
  });
  if (action.kind === "use" && secret.kind === "present") {
    return { password: action.password, secretArn: secret.arn };
  }
  const password = generateOperatorPassword();
  const written = await writeSecret(store, {
    description: `Login password of platform operator principal ${command.principalId}.`,
    purpose: "operator-password",
    secret,
    secretId: source.secretId,
    value: password,
  });
  return { password, secretArn: written.arn };
}

export async function ensureOperatorIdentity(
  command: Extract<CliCommand, { readonly kind: "identity" }>,
  secrets: () => SecretStore,
): Promise<IdentityResult> {
  const { principalId } = command;
  const { password, secretArn } = await operatorPassword(command, secrets);
  const baseClient = new DynamoDBClient({});
  try {
    const repository = makeIdentityRepository(
      makeDynamoDatabase(
        DynamoDBDocumentClient.from(baseClient, {
          marshallOptions: { removeUndefinedValues: true },
        }),
        tableNamesFromEnvironment(),
      ),
    );
    const [principal, material, fence] = await Promise.all([
      repository.principalForId(principalId),
      repository.loadLoginMaterial(principalId),
      repository.bffFenceForPrincipal(principalId),
    ]);
    if (material.principal?.data.id !== principal?.data.id) {
      throw new Error("The operator principal changed while its login was read.");
    }
    const storedPasswordMatches = material.credential
      ? (
          await verifyPasswordEqualized({
            encodedHash: material.credential.data.passwordHash,
            password,
            profiles: [DEFAULT_PASSWORD_PROFILE],
          })
        ).matched
      : false;
    const change = operatorIdentityChange({
      credential: material.credential,
      fence,
      principal,
      principalId,
      rotate: command.rotate,
      security: material.securityState,
      storedPasswordMatches,
    });
    if (change.kind !== "unchanged") {
      const ids = makeIdGenerator();
      await repository.transact(
        operatorIdentityOperations({
          change,
          generateId: () => ids.generate(),
          now: new Date().toISOString(),
          passwordHash: await hashPassword(password, DEFAULT_PASSWORD_PROFILE),
          principalId,
          username: command.username,
        }),
      );
    }
    return {
      outcome:
        change.kind === "unchanged"
          ? "unchanged"
          : change.kind === "create"
            ? "created"
            : "rotated",
      principalId,
      ...(secretArn ? { secretArn } : {}),
    };
  } finally {
    baseClient.destroy();
  }
}
