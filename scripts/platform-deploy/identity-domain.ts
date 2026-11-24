import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { platformStackModule } from "./profiles.ts";
import { singleLine } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

const identityDomainAddress = `${platformStackModule}.module.platform_identity[0].aws_api_gateway_domain_name.identity[0]`;

/** Reads the identity bootstrap completion marker; undefined when it does not exist. */
export type IdentityMarkerReader = (name: string) => Promise<string | undefined>;

export interface IdentityDomainState {
  /** Value for `platform_identity_publish_domain` in the full deployment plan. */
  readonly publishDomain: boolean;
}

/**
 * Keeps the identity custom domain published once it exists, and publishes it
 * up front only when a previous deployment recorded a completed client
 * bootstrap for the current web client secret.
 */
export async function identityDomainState(input: {
  readonly outputs: TerraformOutputs;
  readonly readMarker: IdentityMarkerReader;
  readonly stateResources: readonly string[];
}): Promise<IdentityDomainState> {
  if (input.stateResources.includes(identityDomainAddress)) return { publishDomain: true };
  const bootstrap = input.outputs.platform_identity_bootstrap;
  if (bootstrap === null || typeof bootstrap !== "object") return { publishDomain: false };
  const markerName: unknown = Reflect.get(bootstrap, "completion_marker_name");
  const secretArn: unknown = Reflect.get(bootstrap, "web_client_secret_arn");
  const publicationReady = Reflect.get(bootstrap, "publication_ready") === true;
  if (
    typeof markerName !== "string" ||
    !markerName ||
    typeof secretArn !== "string" ||
    !secretArn
  ) {
    return { publishDomain: false };
  }
  const markerValue = await input.readMarker(markerName);
  return { publishDomain: publicationReady && markerValue === secretArn };
}

export function ssmIdentityMarkerReader(region: string): IdentityMarkerReader {
  const client = new SSMClient({ region });
  return async (name) => {
    try {
      return (await client.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "name" in cause) {
        if (cause.name === "ParameterNotFound") return undefined;
      }
      throw new Error(
        `Identity publication marker lookup failed; refusing to change domain publication: ${singleLine(cause)}`,
      );
    }
  };
}
