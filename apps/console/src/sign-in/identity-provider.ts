import type {
  IdentityProviderResponse,
  IdentityProviderState,
  PutIdentityProviderRequest,
  SetIdentityProviderStateRequest,
} from "@deployments-ai/api-contract";

export const JIT_CHOICES = ["off", "member", "viewer"] as const;

export type JitChoice = (typeof JIT_CHOICES)[number];

export const PROTOCOLS = ["oidc", "saml"] as const satisfies readonly Protocol[];

export type Protocol = IdentityProviderResponse["protocol"];

export type SamlProvider = Extract<IdentityProviderResponse, { readonly protocol: "saml" }>;

export const METADATA_SOURCES = ["url", "document"] as const;

export type MetadataSource = (typeof METADATA_SOURCES)[number];

/** Drafts for both protocols stay in the form, so switching the choice back loses no typing. */
export interface ProviderForm {
  readonly clientId: string;
  readonly displayName: string;
  readonly emailAttribute: string;
  readonly issuer: string;
  readonly jit: JitChoice;
  readonly metadataDocument: string;
  readonly metadataSource: MetadataSource;
  readonly metadataUrl: string;
  readonly newClientSecret: string;
  readonly protocol: Protocol;
  readonly unsolicitedSignIn: boolean;
}

export type ProviderRequest =
  | { readonly kind: "ready"; readonly body: PutIdentityProviderRequest }
  | { readonly kind: "incomplete"; readonly reason: string };

const BLANK_FORM: ProviderForm = {
  clientId: "",
  displayName: "",
  emailAttribute: "",
  issuer: "",
  jit: "off",
  metadataDocument: "",
  metadataSource: "url",
  metadataUrl: "",
  newClientSecret: "",
  protocol: "oidc",
  unsolicitedSignIn: false,
};

export function providerForm(provider: IdentityProviderResponse | null): ProviderForm {
  if (provider === null) return BLANK_FORM;
  const common: ProviderForm = {
    ...BLANK_FORM,
    displayName: provider.displayName,
    jit: provider.jit.kind === "enabled" ? provider.jit.role : "off",
  };
  switch (provider.protocol) {
    case "oidc":
      return { ...common, clientId: provider.clientId, issuer: provider.issuer };
    case "saml":
      return {
        ...common,
        emailAttribute: provider.emailAttribute ?? "",
        metadataSource: provider.metadataUrl === undefined ? "document" : "url",
        metadataUrl: provider.metadataUrl ?? "",
        protocol: "saml",
        unsolicitedSignIn: provider.unsolicitedSignIn === "enabled",
      };
    default: {
      const unhandled: never = provider;
      return unhandled;
    }
  }
}

function oidcRequest(
  form: ProviderForm,
  current: IdentityProviderResponse | null,
): ProviderRequest {
  const issuer = form.issuer.trim();
  const clientId = form.clientId.trim();
  const displayName = form.displayName.trim();
  const clientSecret = form.newClientSecret.trim();
  if (!issuer || !clientId || !displayName) {
    return { kind: "incomplete", reason: "Enter the issuer, client ID, and display name." };
  }
  const stored = current?.protocol === "oidc" ? current : null;
  const newConnection = stored?.issuer !== issuer || stored.clientId !== clientId;
  if (newConnection && !clientSecret) {
    const reason =
      current === null
        ? "Enter the client secret."
        : stored === null
          ? "Switching to OpenID Connect needs the client secret."
          : "Changing the issuer or client ID needs the new client secret.";
    return { kind: "incomplete", reason };
  }
  if (
    stored !== null &&
    !newConnection &&
    !clientSecret &&
    stored.displayName === displayName &&
    providerForm(stored).jit === form.jit
  ) {
    return { kind: "incomplete", reason: "Nothing changed." };
  }
  return {
    body: {
      clientId,
      displayName,
      issuer,
      jit: form.jit === "off" ? { kind: "disabled" } : { kind: "enabled", role: form.jit },
      ...(clientSecret ? { clientSecret } : {}),
    },
    kind: "ready",
  };
}

/**
 * Saving a SAML provider always re-reads its metadata. New certificates keep the connection only
 * when they come from the same metadata URL; pasted ones start a new connection.
 */
function samlRequest(
  form: ProviderForm,
  current: IdentityProviderResponse | null,
): ProviderRequest {
  const displayName = form.displayName.trim();
  const metadataUrl = form.metadataUrl.trim();
  const emailAttribute = form.emailAttribute.trim();
  let metadata: Extract<PutIdentityProviderRequest, { protocol: "saml" }>["metadata"];
  switch (form.metadataSource) {
    case "url":
      if (!metadataUrl || !displayName) {
        return { kind: "incomplete", reason: "Enter the metadata URL and display name." };
      }
      metadata = { url: metadataUrl };
      break;
    case "document": {
      if (!form.metadataDocument.trim() || !displayName) {
        const pastedBefore = current?.protocol === "saml" && current.metadataUrl === undefined;
        const reason = pastedBefore
          ? "Paste the metadata XML again. The platform keeps only what it read from it."
          : "Paste the metadata XML and enter the display name.";
        return { kind: "incomplete", reason };
      }
      metadata = { document: form.metadataDocument };
      break;
    }
    default: {
      const unhandled: never = form.metadataSource;
      return unhandled;
    }
  }
  return {
    body: {
      displayName,
      jit: form.jit === "off" ? { kind: "disabled" } : { kind: "enabled", role: form.jit },
      metadata,
      protocol: "saml",
      unsolicitedSignIn: form.unsolicitedSignIn ? "enabled" : "disabled",
      ...(emailAttribute ? { emailAttribute } : {}),
    },
    kind: "ready",
  };
}

export function providerRequest(
  form: ProviderForm,
  current: IdentityProviderResponse | null,
): ProviderRequest {
  switch (form.protocol) {
    case "oidc":
      return oidcRequest(form, current);
    case "saml":
      return samlRequest(form, current);
    default: {
      const unhandled: never = form.protocol;
      return unhandled;
    }
  }
}

/** What the first page or pages of `GET /v1/identity-provider/links` showed. */
export type LinkedAccounts =
  | { readonly kind: "counted"; readonly count: number; readonly more: boolean }
  | { readonly kind: "unknown" };

function confirmationSentence(links: LinkedAccounts): string | null {
  if (links.kind === "unknown") {
    return "Each linked member confirms their email once on their next sign-in.";
  }
  if (links.count === 0 && !links.more) return null;
  if (links.count === 1 && !links.more) {
    return "The linked member confirms their email once on their next sign-in.";
  }
  return `Each of the ${links.count}${links.more ? " or more" : ""} linked members confirms their email once on their next sign-in.`;
}

/**
 * A protocol switch starts a new connection: links belong to the old issuer, and enforcement
 * proven through the old connection no longer holds.
 */
export function protocolSwitchWarning(
  current: IdentityProviderResponse | null,
  protocol: Protocol,
  links: LinkedAccounts,
): string | null {
  if (current === null || current.protocol === protocol) return null;
  const required = current.state.kind === "active" && current.state.enforcement === "required";
  return [
    "Switching protocols starts a new connection.",
    confirmationSentence(links),
    required ? "Required sign-in goes back to optional until an owner requires it again." : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");
}

export type ProviderMove = "disable" | "enable" | "make-optional" | "require";

export const MOVE_REQUESTS: { readonly [Move in ProviderMove]: SetIdentityProviderStateRequest } = {
  disable: { kind: "disabled" },
  enable: { enforcement: "optional", kind: "active" },
  "make-optional": { enforcement: "optional", kind: "active" },
  require: { enforcement: "required", kind: "active" },
};

export function providerMoves(
  state: IdentityProviderState,
  mayEnforce: boolean,
): readonly ProviderMove[] {
  if (state.kind === "disabled") return ["enable"];
  const enforcement: ProviderMove = state.enforcement === "required" ? "make-optional" : "require";
  return mayEnforce ? [enforcement, "disable"] : ["disable"];
}
