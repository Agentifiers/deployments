import {
  CallbackChannelOrigin,
  Ulid,
  type CallbackChannelOrigin as Origin,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import type { MessageRecordValue, RunRecordValue } from "./types.ts";

const {
  channelBindingId: _channelBindingId,
  kind: _kind,
  ...originFields
} = CallbackChannelOrigin.fields;
const decodeChannelIngressMetadata = Schema.decodeUnknownOption(
  Schema.Struct({
    ...originFields,
    bindingId: Ulid,
    source: Schema.Literal("channel-ingress"),
  }),
);

export function channelOriginOf(
  run: RunRecordValue,
  message: MessageRecordValue | undefined,
): Origin | undefined {
  const caller = run.data.initiatingCaller;
  if (
    run.data.trigger !== "chat" ||
    caller?.type !== "ingress" ||
    caller.sourceKind !== "channel-binding"
  ) {
    return undefined;
  }
  const metadata = message?.data.metadata;
  if (metadata?.source !== "channel-ingress" || metadata.bindingId !== caller.sourceId) {
    return undefined;
  }
  const decoded = decodeChannelIngressMetadata(metadata);
  if (Option.isNone(decoded)) {
    console.warn("Channel ingress metadata did not decode; the callback carries no origin.", {
      event: "callback_origin_malformed",
      messageId: message?.data.id,
      runId: run.data.id,
    });
    return undefined;
  }
  const ingress = decoded.value;
  return {
    channelBindingId: caller.sourceId,
    ...(ingress.externalAccountId ? { externalAccountId: ingress.externalAccountId } : {}),
    externalChannelId: ingress.externalChannelId,
    externalMessageId: ingress.externalMessageId,
    externalThreadKey: ingress.externalThreadKey,
    ...(ingress.externalWorkspaceId ? { externalWorkspaceId: ingress.externalWorkspaceId } : {}),
    kind: "channel",
    provider: ingress.provider,
    sender: {
      ...(ingress.sender.displayName === undefined
        ? {}
        : { displayName: ingress.sender.displayName }),
      id: ingress.sender.id,
    },
  };
}
