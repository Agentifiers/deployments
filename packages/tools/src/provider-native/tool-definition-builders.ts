import {
  encodedPath,
  type ProviderNativeInputSchema,
  type ProviderNativeInputSchemaProperty,
} from "./core.ts";

export function objectSchema(
  properties: Readonly<Record<string, ProviderNativeInputSchemaProperty>>,
  required: readonly string[] = [],
): ProviderNativeInputSchema {
  return {
    additionalProperties: false,
    properties,
    type: "object",
    ...(required.length > 0 ? { required } : {}),
  };
}

export function stringProperty(description?: string): ProviderNativeInputSchemaProperty {
  return { type: "string", minLength: 1, ...(description ? { description } : {}) };
}

export function integerProperty(minimum = 1, maximum?: number): ProviderNativeInputSchemaProperty {
  return {
    minimum,
    type: "integer",
    ...(maximum === undefined ? {} : { maximum }),
  };
}

export function jsonObjectProperty(): ProviderNativeInputSchemaProperty {
  return { additionalProperties: true, type: "object" };
}

export function staticProviderUrl(host: string, pathSegments: readonly string[]): string {
  const url = new URL(`https://${host}`);
  url.pathname = `/${encodedPath(pathSegments.join("/"))}`;
  return url.toString();
}
