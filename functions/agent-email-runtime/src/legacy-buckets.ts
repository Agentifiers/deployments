const AGENT_EMAIL_LEGACY_BUCKETS_ENV = "DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON";

export function legacyAgentEmailBuckets(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment[AGENT_EMAIL_LEGACY_BUCKETS_ENV]?.trim();
  if (!value) return [];
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${AGENT_EMAIL_LEGACY_BUCKETS_ENV} must be a JSON array of non-empty strings.`);
  }
  return [...new Set(decoded.map((entry) => entry.trim()))];
}
