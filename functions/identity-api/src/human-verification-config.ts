import type { HumanVerificationWidget } from "@deployments-ai/identity";
import { parseAwsSecretReference } from "@deployments-ai/secret-store";

export interface HumanVerificationConfig {
  readonly secretParameterArn: string;
  readonly verifyUrl: string;
  readonly widget: HumanVerificationWidget;
}

const fields = [
  "responseField",
  "scriptUrl",
  "secretParameterArn",
  "siteKey",
  "verifyUrl",
  "widgetClass",
  "widgetOrigins",
];
const markupName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const siteKeyPattern = /^[A-Za-z0-9_.-]{1,256}$/u;
const sourceOrigin = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/u;

function httpsUrl(value: unknown, field: string) {
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Human verification ${field} must be an HTTPS URL.`);
  }
  return url.href;
}

function matching(value: unknown, pattern: RegExp, field: string) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Human verification ${field} is invalid.`);
  }
  return value;
}

export function parseHumanVerificationConfig(
  raw: string | undefined,
): HumanVerificationConfig | undefined {
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error("Human verification configuration must be an object with known fields.");
  }
  const input = value as Record<string, unknown>;
  const secretParameterArn =
    typeof input.secretParameterArn === "string" ? input.secretParameterArn : "";
  if (parseAwsSecretReference(secretParameterArn).kind !== "parameter") {
    throw new Error("Human verification secretParameterArn must name an SSM parameter.");
  }
  const widgetOrigins = input.widgetOrigins ?? [];
  if (!Array.isArray(widgetOrigins)) {
    throw new Error("Human verification widgetOrigins must be a list.");
  }
  return {
    secretParameterArn,
    verifyUrl: httpsUrl(input.verifyUrl, "verifyUrl"),
    widget: {
      responseField: matching(input.responseField, markupName, "responseField"),
      scriptUrl: httpsUrl(input.scriptUrl, "scriptUrl"),
      siteKey: matching(input.siteKey, siteKeyPattern, "siteKey"),
      widgetClass: matching(input.widgetClass, markupName, "widgetClass"),
      widgetOrigins: widgetOrigins.map((origin: unknown) =>
        matching(origin, sourceOrigin, "widgetOrigins"),
      ),
    },
  };
}
