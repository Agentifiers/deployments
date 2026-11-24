import { GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { describe, expect, test } from "bun:test";
import { INVITATION_EMAIL_ENV, invitationEmailFromEnvironment } from "./invitation-email-config.ts";

describe("invitation email configuration", () => {
  test("stays disabled without the identity email key", () => {
    expect(invitationEmailFromEnvironment({ [INVITATION_EMAIL_ENV.stage]: "dev" })).toBeUndefined();
    expect(
      invitationEmailFromEnvironment({ [INVITATION_EMAIL_ENV.identityEmailKmsKeyId]: "  " }),
    ).toBeUndefined();
  });

  test("requires the stage once the key is configured", () => {
    expect(() =>
      invitationEmailFromEnvironment({
        [INVITATION_EMAIL_ENV.identityEmailKmsKeyId]:
          "arn:aws:kms:us-east-1:123456789012:key/email",
      }),
    ).toThrow(INVITATION_EMAIL_ENV.stage);
  });

  test("encrypts invitation payloads under the configured key and stage", async () => {
    const commands: GenerateDataKeyCommand[] = [];
    const kms = {
      send: async (command: GenerateDataKeyCommand) => {
        commands.push(command);
        return { CiphertextBlob: new Uint8Array([1]), Plaintext: new Uint8Array(32).fill(2) };
      },
    } as unknown as KMSClient;
    const invitationEmail = invitationEmailFromEnvironment(
      {
        [INVITATION_EMAIL_ENV.identityEmailKmsKeyId]:
          "arn:aws:kms:us-east-1:123456789012:key/email",
        [INVITATION_EMAIL_ENV.stage]: "dev",
      },
      kms,
    );

    await invitationEmail!.encryptPayload({ recipient: "a@example.test" }, { deliveryId: "d" });

    expect(commands[0]?.input).toMatchObject({
      EncryptionContext: { deliveryId: "d", stage: "dev" },
      KeyId: "arn:aws:kms:us-east-1:123456789012:key/email",
    });
  });
});
