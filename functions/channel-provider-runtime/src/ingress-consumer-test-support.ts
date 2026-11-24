import type { ChannelIngressConsumerDependencies } from "./ingress-consumer.ts";

export const withoutAttachmentCapture: Pick<
  ChannelIngressConsumerDependencies,
  "ingressAttachments" | "loadRelease"
> = {
  ingressAttachments: {
    prepare: async () => {
      throw new Error("must not capture attachments");
    },
  },
  loadRelease: async () => {
    throw new Error("must not load releases");
  },
};
