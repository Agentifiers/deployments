import type { ProviderNativeHttpToolDefinition } from "../core.ts";
import { microsoftOutlookNativeHttpToolDefinitions } from "./microsoft-outlook.ts";
import { microsoftSharePointNativeHttpToolDefinitions } from "./microsoft-sharepoint.ts";
import { microsoftTeamsNativeHttpToolDefinitions } from "./microsoft-teams.ts";
import { oneDriveNativeHttpToolDefinitions } from "./onedrive.ts";

export { microsoftTeamsNativeHttpToolDefinitions };

export const microsoftNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...microsoftOutlookNativeHttpToolDefinitions,
  ...microsoftSharePointNativeHttpToolDefinitions,
  ...microsoftTeamsNativeHttpToolDefinitions,
  ...oneDriveNativeHttpToolDefinitions,
];
