import type { CommandCatalog } from "./types.ts";
import { action, id, list, mutate, requiredJson, requiredText, text } from "./catalog-helpers.ts";
import { CliError, ExitCode } from "./errors.ts";

const LOGIN_DOMAINS_PATH = "/v1/login-domains";
const IDENTITY_PROVIDER_PATH = "/v1/identity-provider";
const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;

/** Body fields only one protocol takes, keyed to the flag that sets them. */
const PROTOCOL_FLAGS = {
  oidc: {
    clientId: "--client-id",
    clientSecret: "--client-secret, --client-secret-env, or --client-secret-file",
    issuer: "--issuer",
  },
  saml: {
    emailAttribute: "--email-attribute",
    metadataDocument: "--metadata-file",
    metadataUrl: "--metadata-url",
    unsolicitedSignIn: "--unsolicited-sign-in",
  },
} as const;

function rejectFlags(
  chosen: keyof typeof PROTOCOL_FLAGS,
  foreign: (typeof PROTOCOL_FLAGS)[keyof typeof PROTOCOL_FLAGS],
  body: Readonly<Record<string, unknown>>,
) {
  for (const [field, flag] of Object.entries(foreign)) {
    if (body[field] !== undefined) {
      throw new CliError(`--protocol ${chosen} does not take ${flag}.`, ExitCode.usage);
    }
  }
}

export function identityProviderBody(
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { metadataDocument, metadataUrl, protocol, ...fields } = body;
  switch (protocol) {
    case undefined:
    case "oidc": {
      rejectFlags("oidc", PROTOCOL_FLAGS.saml, body);
      if (fields.issuer === undefined || fields.clientId === undefined) {
        throw new CliError("An OIDC provider needs --issuer and --client-id.", ExitCode.usage);
      }
      return fields;
    }
    case "saml": {
      rejectFlags("saml", PROTOCOL_FLAGS.oidc, body);
      if (metadataUrl === undefined && metadataDocument === undefined) {
        throw new CliError(
          "A SAML provider needs --metadata-url or --metadata-file.",
          ExitCode.usage,
        );
      }
      return {
        ...fields,
        metadata: metadataUrl === undefined ? { document: metadataDocument } : { url: metadataUrl },
        protocol,
      };
    }
    default:
      throw new CliError("--protocol must be oidc or saml.", ExitCode.usage);
  }
}

export const identityFederationCommandCatalog: CommandCatalog = {
  "login-domain": {
    summary: "Email domains the organization proves it controls for single sign-on",
    actions: {
      list: list(LOGIN_DOMAINS_PATH, "organization", "List login domains", pagination),
      add: action({
        summary: "Add a login domain and print the DNS TXT record that verifies it",
        method: "POST",
        path: LOGIN_DOMAINS_PATH,
        scope: "organization",
        output: "detail",
        args: { domain: requiredText("Domain, such as example.com") },
        idempotent: true,
      }),
      verify: action({
        summary: "Verify a login domain once its DNS TXT record is published",
        method: "POST",
        path: `${LOGIN_DOMAINS_PATH}/:id/verify`,
        scope: "organization",
        output: "detail",
        args: { id },
        idempotent: true,
      }),
      remove: mutate("DELETE", LOGIN_DOMAINS_PATH, "organization", "Remove a login domain", {
        id,
      }),
    },
  },
  "identity-provider": {
    summary: "The organization's OIDC or SAML identity provider for single sign-on",
    actions: {
      show: action({
        summary: "Show the identity provider and the values to register with it",
        method: "GET",
        path: IDENTITY_PROVIDER_PATH,
        scope: "organization",
        output: "detail",
      }),
      set: action({
        summary:
          "Configure the OIDC or SAML identity provider; a new OIDC issuer or client ID needs a new secret",
        method: "PUT",
        path: IDENTITY_PROVIDER_PATH,
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          protocol: {
            definition: {
              type: "enum",
              description: "oidc or saml (default oidc)",
              options: ["oidc", "saml"],
            },
            target: "body",
          },
          "display-name": {
            ...requiredText("Name shown on the sign-in button"),
            field: "displayName",
          },
          jit: requiredJson(
            'Just-in-time provisioning, such as {"kind":"enabled","role":"member"}',
          ),
          issuer: text("OIDC issuer URL"),
          "client-id": text("OIDC OAuth client ID"),
          "client-secret": text("OIDC OAuth client secret (prefer env or file source)", "control"),
          "client-secret-env": text(
            "Environment variable containing the OIDC OAuth client secret",
            "control",
          ),
          "client-secret-file": text("File containing the OIDC OAuth client secret", "control"),
          "metadata-url": text("HTTPS URL of the SAML identity provider's metadata"),
          "metadata-file": text(
            "File containing the SAML identity provider's metadata XML",
            "control",
          ),
          "email-attribute": text(
            "SAML attribute that carries the email; when set, the NameID is never used",
          ),
          "unsolicited-sign-in": {
            definition: {
              type: "enum",
              description: "IdP-initiated SAML sign-in (default disabled)",
              options: ["disabled", "enabled"],
            },
            target: "body",
          },
        },
        secretInputs: [
          {
            directArgument: "client-secret",
            environmentArgument: "client-secret-env",
            fileArgument: "client-secret-file",
            bodyField: "clientSecret",
            required: false,
          },
        ],
        fileInputs: [
          {
            argument: "metadata-file",
            bodyField: "metadataDocument",
            exclusiveWith: "metadata-url",
            format: "text",
            required: false,
          },
        ],
        shapeBody: identityProviderBody,
      }),
      "set-state": action({
        summary: "Activate, require, or disable sign-in through the identity provider",
        method: "PUT",
        path: `${IDENTITY_PROVIDER_PATH}/state`,
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          kind: requiredText("active or disabled"),
          enforcement: text("optional or required, when active"),
        },
      }),
      delete: action({
        summary: "Delete the identity provider and its client secret",
        method: "DELETE",
        path: IDENTITY_PROVIDER_PATH,
        scope: "organization",
        output: "detail",
        idempotent: true,
        destructive: true,
      }),
      links: list(
        `${IDENTITY_PROVIDER_PATH}/links`,
        "organization",
        "List identities linked through the identity provider",
        pagination,
      ),
      unlink: mutate(
        "DELETE",
        `${IDENTITY_PROVIDER_PATH}/links`,
        "organization",
        "Remove a federated identity link",
        { id },
      ),
    },
  },
};
