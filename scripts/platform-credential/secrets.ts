import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";

/** A SecureString parameter as read from Parameter Store, with its trimmed value if it has one. */
export type StoredSecret =
  | { readonly kind: "missing" }
  | {
      readonly arn: string;
      readonly current: { readonly value: string; readonly versionId: string } | undefined;
      readonly kind: "present";
    };

export interface WrittenSecret {
  readonly arn: string;
  readonly versionId: string;
}

export type SecretPurpose = "environment-api-key" | "operator-password";

export interface SecretStore {
  /** Creates the parameter with its first value; `secretId` must be a name, not an ARN. */
  readonly create: (input: {
    readonly description: string;
    readonly purpose: SecretPurpose;
    readonly secretId: string;
    readonly value: string;
  }) => Promise<WrittenSecret>;
  readonly put: (input: {
    readonly secretId: string;
    readonly value: string;
  }) => Promise<WrittenSecret>;
  readonly read: (secretId: string) => Promise<StoredSecret>;
}

/** Creates a missing parameter or writes a new version of an existing one. */
export function writeSecret(
  store: SecretStore,
  input: {
    readonly description: string;
    readonly purpose: SecretPurpose;
    readonly secret: StoredSecret;
    readonly secretId: string;
    readonly value: string;
  },
) {
  return input.secret.kind === "missing"
    ? store.create(input)
    : store.put({ secretId: input.secretId, value: input.value });
}

/**
 * The tool's secrets are SecureString parameters, named by path, under the AWS-managed `aws/ssm`
 * key. A version is the parameter's version number, which grows by one on every write.
 */
export function awsSecretStore(client: SSMClient): SecretStore {
  // PutParameter answers with the version only; the ARN comes from the parameter's metadata.
  const written = async (secretId: string, version: number | undefined) => {
    const { Parameter: parameter } = await client.send(new GetParameterCommand({ Name: secretId }));
    if (!parameter?.ARN || !version) {
      throw new Error(`Parameter Store returned no ARN and version for ${secretId}.`);
    }
    return { arn: parameter.ARN, versionId: String(version) };
  };
  return {
    create: async ({ description, purpose, secretId, value }) => {
      const created = await client
        .send(
          new PutParameterCommand({
            Description: description,
            Name: secretId,
            Overwrite: false,
            Tags: [
              { Key: "ManagedBy", Value: "deployments-platform-credential" },
              { Key: "Purpose", Value: purpose },
            ],
            Type: "SecureString",
            Value: value,
          }),
        )
        .catch((cause: unknown) => {
          if (cause instanceof Error && cause.name === "ParameterAlreadyExists") {
            throw new Error(
              `Parameter ${secretId} was created concurrently; run the command again.`,
            );
          }
          throw cause;
        });
      return written(secretId, created.Version);
    },
    put: async ({ secretId, value }) => {
      const put = await client.send(
        new PutParameterCommand({
          Name: secretId,
          Overwrite: true,
          Type: "SecureString",
          Value: value,
        }),
      );
      return written(secretId, put.Version);
    },
    read: async (secretId) => {
      try {
        const { Parameter: parameter } = await client.send(
          new GetParameterCommand({ Name: secretId, WithDecryption: true }),
        );
        if (!parameter?.ARN) throw new Error(`Parameter Store returned no ARN for ${secretId}.`);
        if (parameter.Type !== "SecureString") {
          throw new Error(`Parameter ${secretId} must be a SecureString.`);
        }
        const value = parameter.Value?.trim();
        return {
          arn: parameter.ARN,
          current:
            value && parameter.Version
              ? { value, versionId: String(parameter.Version) }
              : undefined,
          kind: "present",
        };
      } catch (cause) {
        if (cause instanceof ParameterNotFound) return { kind: "missing" };
        throw cause;
      }
    },
  };
}
