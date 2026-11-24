import { KMSClient } from "@aws-sdk/client-kms";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  makeKmsEnvelopeAdapter,
  organizationInvitationForEmail,
  pendingFederationLink,
} from "@deployments-ai/db";
import { makeIdentityEmailWorkerHandler } from "./delivery-handler.ts";
import { database, repository, required } from "./runtime.ts";

const ses = new SESv2Client({});
const sender = required("DEPLOYMENTS_AI_IDENTITY_EMAIL_SENDER");
const envelope = makeKmsEnvelopeAdapter({
  keyId: required("DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID"),
  kms: new KMSClient({}),
  stage: required("DEPLOYMENTS_AI_STAGE"),
});

export const handler = makeIdentityEmailWorkerHandler({
  applicationOrigin: required("DEPLOYMENTS_AI_IDENTITY_APPLICATION_ORIGIN").replace(/\/+$/u, ""),
  decrypt: envelope.decrypt,
  invitationForEmail: (organizationId, invitationId) =>
    organizationInvitationForEmail(database, organizationId, invitationId),
  issuer: required("DEPLOYMENTS_AI_IDENTITY_ISSUER").replace(/\/$/u, ""),
  maxReceiveCount: Number(required("DEPLOYMENTS_AI_IDENTITY_EMAIL_MAX_RECEIVE_COUNT")),
  now: () => new Date(),
  pendingFederationLink: (token, now) => pendingFederationLink(database, token, now),
  repository,
  send: async ({ content, recipient }) => {
    await ses.send(
      new SendEmailCommand({
        Content: {
          Simple: {
            Body: {
              Html: { Charset: "UTF-8", Data: content.html },
              Text: { Charset: "UTF-8", Data: content.text },
            },
            Subject: { Charset: "UTF-8", Data: content.subject },
          },
        },
        Destination: { ToAddresses: [recipient] },
        FromEmailAddress: sender,
      }),
    );
  },
});
