export function parseLegacyArtifactBuckets(
  value: string | undefined,
  name = "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
) {
  const normalized = value?.trim();
  if (!normalized) return [];
  const decoded: unknown = JSON.parse(normalized);
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings.`);
  }
  return [...new Set(decoded.map((entry) => entry.trim()))];
}

export function artifactBucketAllowed(
  candidate: string,
  current: string,
  legacy: readonly string[] = [],
) {
  return candidate === current || legacy.includes(candidate);
}
