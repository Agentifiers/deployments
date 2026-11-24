import "@tanstack/react-start/server-only";
import type { DirectoryResponse } from "@deployments-ai/api-contract";
import { PlatformApiError } from "../errors.ts";
import { signInPlatform, type OrganizationScope, type SignInPlatform } from "./sign-in-data.ts";

export async function loadDirectory(
  accessToken: string,
  scope: OrganizationScope,
  client: SignInPlatform = signInPlatform,
): Promise<DirectoryResponse | null> {
  try {
    return await client.callRoute("getDirectory", { scope }, accessToken);
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.code === "directory_not_configured") {
      return null;
    }
    throw error;
  }
}
