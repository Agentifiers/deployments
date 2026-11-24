export function slackMetadata(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function slackMetadataText(value: Readonly<Record<string, unknown>>, field: string) {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
