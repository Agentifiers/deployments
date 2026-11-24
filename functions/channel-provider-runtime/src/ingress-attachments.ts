import {
  CHANNEL_ATTACHMENT_SOURCES,
  ChannelAttachmentDownloadError,
  downloadChannelAttachment,
  type ChannelAttachmentDownloadOptions,
  type ChannelAttachmentReference,
} from "@deployments-ai/channel-adapters";
import type { DynamoDatabaseService, IngressInputArtifactScope, Ulid } from "@deployments-ai/db";
import type { FileTextExtractor } from "@deployments-ai/file-text";
import {
  IngressAttachmentReadError,
  makeIngressAttachments,
  type IngressAttachmentCandidate,
  type IngressAttachmentObjectStore,
  type IngressAttachments,
} from "@deployments-ai/ingress-media";
import type { ChannelBinding } from "./channel-credentials.ts";
import type { DecodedChannelIngressQueueMessageV1 } from "./ingress-message.ts";

export function channelAttachmentCandidates(
  messages: readonly DecodedChannelIngressQueueMessageV1[],
): IngressAttachmentCandidate<ChannelAttachmentReference>[] {
  return messages.flatMap(({ ingress }) => {
    const source = CHANNEL_ATTACHMENT_SOURCES[ingress.provider];
    if (!source) return [];
    return (ingress.attachments ?? []).flatMap((attachment, ordinal) => {
      const reference = source(attachment);
      if (!reference) return [];
      return [
        {
          declared: {
            ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
            ...(attachment.contentType === undefined
              ? {}
              : { contentType: attachment.contentType }),
            ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
            kind: attachment.kind,
          },
          identity: {
            externalMessageId: ingress.externalMessageId,
            ordinal,
            type: "channel-attachment" as const,
          },
          reference,
        },
      ];
    });
  });
}

export interface ChannelIngressAttachmentsPorts {
  readonly artifactBucket: string;
  readonly extractor: FileTextExtractor;
  readonly openObjectStore: (
    scope: IngressInputArtifactScope,
  ) => Promise<IngressAttachmentObjectStore>;
  readonly readCredentialValues: (
    binding: ChannelBinding,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly transport: Omit<ChannelAttachmentDownloadOptions, "maxBytes" | "signal">;
}

export function makeChannelIngressAttachments(
  dependencies: ChannelIngressAttachmentsPorts & {
    readonly database: DynamoDatabaseService;
    readonly loadBinding: (
      scope: IngressInputArtifactScope,
      bindingId: Ulid,
    ) => Promise<ChannelBinding | undefined>;
  },
): IngressAttachments<ChannelAttachmentReference> {
  return makeIngressAttachments({
    artifactBucket: dependencies.artifactBucket,
    database: dependencies.database,
    extractor: dependencies.extractor,
    onTransientFailure: "omit",
    openObjectStore: dependencies.openObjectStore,
    openReader: async ({ owner, scope }) => {
      const binding = await dependencies.loadBinding(scope, owner.sourceId);
      if (!binding) throw new Error("The channel binding that owns these attachments is gone.");
      const credentials = await dependencies.readCredentialValues(binding);
      return async (reference, limits) => {
        try {
          return await downloadChannelAttachment(reference, credentials, {
            ...dependencies.transport,
            ...limits,
          });
        } catch (cause) {
          if (!(cause instanceof ChannelAttachmentDownloadError)) throw cause;
          throw new IngressAttachmentReadError(cause.kind, cause.message);
        }
      };
    },
  });
}
