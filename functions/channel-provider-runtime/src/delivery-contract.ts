import type { TeamsConnectorClient } from "@deployments-ai/channel-adapters/teams";
import type { TelegramDeliveryPayload } from "@deployments-ai/channel-adapters/telegram";
import type {
  ChannelIngressDispatchAssessment,
  DynamoDatabaseService,
  PlatformRecord,
  Ulid,
} from "@deployments-ai/db";

import type { AwsRcsProviderCredential, PreparedAwsRcsDelivery } from "./aws-rcs-delivery.ts";
import type { ExternalResponsePublication } from "./external-response-publication.ts";

export interface DeliveryMessage {
  readonly deliveryId: string;
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
}

export type DeliveryProvider =
  | "aws_end_user_messaging_rcs"
  | "slack_cloudflare_edge"
  | "slack_edge"
  | "teams_bot_framework"
  | "telegram";

export interface DeliveryCommand extends DeliveryMessage {
  readonly channelBindingId?: string;
  readonly payload: unknown;
  readonly provider: DeliveryProvider;
  readonly reference: unknown;
}

export type Delivery = Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>;

export interface ChannelDeliveryDependencies {
  readonly database: DynamoDatabaseService;
  readonly externalPublication?: ExternalResponsePublication;
  readonly generateId: () => Promise<Ulid>;
  readonly ingressDispatch?: {
    readonly assess: (boundary: {
      readonly bindingId: Ulid;
      readonly environmentId: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
      readonly routeId: string;
      readonly throughSequence: number;
    }) => Promise<ChannelIngressDispatchAssessment>;
  };
  readonly now?: () => Date;
  readonly readCredential: (message: DeliveryCommand) => Promise<Readonly<Record<string, string>>>;
  readonly prepareAwsRcs?: (
    credential: AwsRcsProviderCredential,
  ) => Promise<PreparedAwsRcsDelivery>;
  readonly sendSlack?: (
    token: string,
    payload: unknown,
  ) => Promise<{ readonly providerMessageId?: string }>;
  readonly sendTelegram?: (
    botToken: string,
    payload: TelegramDeliveryPayload,
  ) => Promise<{ readonly providerMessageId?: string }>;
  /** Bot Connector client for Teams deliveries; tests inject a transport-backed client. */
  readonly teamsConnector?: TeamsConnectorClient;
}
