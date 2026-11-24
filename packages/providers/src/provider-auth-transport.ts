import { Buffer } from "node:buffer";

import type { ProviderAuthTransport } from "./provider-definitions.ts";

export type AppliedProviderAuthTransport = {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
};

function requiredTransportField(
  fields: Readonly<Record<string, unknown>>,
  fieldKey: string,
): string {
  const value = fields[fieldKey];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Provider credential is missing required transport field ${fieldKey}.`);
  }
  return value.trim();
}

export function applyProviderAuthTransport(args: {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly transport: ProviderAuthTransport;
  readonly url: string;
}): AppliedProviderAuthTransport {
  const { transport } = args;
  if (transport.type === "basic") {
    const username = transport.usernameFieldKey
      ? requiredTransportField(args.fields, transport.usernameFieldKey)
      : "";
    const password = transport.passwordFieldKey
      ? requiredTransportField(args.fields, transport.passwordFieldKey)
      : "";
    return Object.freeze({
      headers: Object.freeze({
        authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      }),
      url: args.url,
    });
  }
  if (transport.type === "headers") {
    return Object.freeze({
      headers: Object.freeze(
        Object.fromEntries(
          transport.headerFields!.map((entry) => [
            entry.headerName,
            `${entry.prefix}${requiredTransportField(args.fields, entry.fieldKey)}`,
          ]),
        ),
      ),
      url: args.url,
    });
  }
  const value = `${transport.prefix}${requiredTransportField(args.fields, transport.fieldKey!)}`;
  if (transport.type === "query") {
    const url = new URL(args.url);
    url.searchParams.set(transport.parameterName!, value);
    return Object.freeze({ headers: Object.freeze({}), url: url.toString() });
  }
  const headerName = transport.type === "bearer" ? "authorization" : transport.headerName!;
  return Object.freeze({
    headers: Object.freeze({ [headerName]: value }),
    url: args.url,
  });
}
