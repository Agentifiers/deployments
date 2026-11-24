import { describe, expect, test } from "bun:test";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { loadAwsSecretString, parseAwsSecretReference } from "./index.ts";

describe("AWS secret references", () => {
  test("recognizes Secrets Manager and Parameter Store ARNs", () => {
    expect(
      parseAwsSecretReference(
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:identity-web-client-AbCdEf",
      ),
    ).toEqual({
      kind: "secret",
      reference: "arn:aws:secretsmanager:us-east-2:123456789012:secret:identity-web-client-AbCdEf",
      region: "us-east-2",
    });
    expect(
      parseAwsSecretReference("arn:aws:ssm:us-east-2:123456789012:parameter/platform/dev/key"),
    ).toEqual({
      kind: "parameter",
      reference: "arn:aws:ssm:us-east-2:123456789012:parameter/platform/dev/key",
      region: "us-east-2",
    });
  });

  test("decrypts a SecureString parameter", async () => {
    const commands: GetParameterCommand[] = [];
    const value = await loadAwsSecretString(
      "arn:aws:ssm:us-east-2:123456789012:parameter/platform/dev/key",
      {
        parameterStore: {
          async send(command) {
            commands.push(command);
            return { $metadata: {}, Parameter: { Value: "parameter-value" } };
          },
        },
      },
    );

    expect(value).toBe("parameter-value");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetParameterCommand);
    expect(commands[0]?.input.WithDecryption).toBe(true);
  });

  test("preserves Secrets Manager version selectors for rotating secrets", async () => {
    const commands: GetSecretValueCommand[] = [];
    const value = await loadAwsSecretString(
      "arn:aws:secretsmanager:us-east-2:123456789012:secret:identity-web-client-AbCdEf",
      {
        secretsManager: {
          async send(command) {
            commands.push(command);
            return { $metadata: {}, SecretString: "secret-value" };
          },
        },
        versionId: "version-1",
        versionStage: "AWSCURRENT",
      },
    );

    expect(value).toBe("secret-value");
    expect(commands[0]?.input.VersionId).toBe("version-1");
    expect(commands[0]?.input.VersionStage).toBe("AWSCURRENT");
  });
});
