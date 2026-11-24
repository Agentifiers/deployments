import type { ProviderNativeHttpToolDefinition } from "../core.ts";
import { audiencetapNativeHttpToolDefinitions } from "./audiencetap.ts";
import { clearbitNativeHttpToolDefinitions } from "./clearbit.ts";
import { dubCoNativeHttpToolDefinitions } from "./dub-co.ts";
import { netsuiteNativeHttpToolDefinitions } from "./netsuite.ts";
import { plivoNativeHttpToolDefinitions } from "./plivo.ts";
import { postscriptNativeHttpToolDefinitions } from "./postscript.ts";
import { rewardfulNativeHttpToolDefinitions } from "./rewardful.ts";
import { shopifyNativeHttpToolDefinitions } from "./shopify.ts";
import { twilioNativeHttpToolDefinitions } from "./twilio.ts";

export {
  audiencetapNativeHttpToolDefinitions,
  clearbitNativeHttpToolDefinitions,
  dubCoNativeHttpToolDefinitions,
  plivoNativeHttpToolDefinitions,
  postscriptNativeHttpToolDefinitions,
  rewardfulNativeHttpToolDefinitions,
  twilioNativeHttpToolDefinitions,
};

export const additionalBusinessNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    ...clearbitNativeHttpToolDefinitions,
    ...rewardfulNativeHttpToolDefinitions,
    ...dubCoNativeHttpToolDefinitions,
    ...twilioNativeHttpToolDefinitions,
    ...plivoNativeHttpToolDefinitions,
    ...postscriptNativeHttpToolDefinitions,
    ...audiencetapNativeHttpToolDefinitions,
  ];

export const businessNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...netsuiteNativeHttpToolDefinitions,
  ...shopifyNativeHttpToolDefinitions,
  ...additionalBusinessNativeHttpToolDefinitions,
];
