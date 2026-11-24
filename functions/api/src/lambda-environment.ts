export function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function optionalStringArray(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) return [];
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings.`);
  }
  return [...new Set(decoded.map((entry) => entry.trim()))];
}

export function optionalPair(environment: NodeJS.ProcessEnv, left: string, right: string) {
  const leftValue = environment[left]?.trim();
  const rightValue = environment[right]?.trim();
  if (Boolean(leftValue) !== Boolean(rightValue)) {
    throw new Error(`${left} and ${right} must be configured together.`);
  }
  return leftValue && rightValue ? ([leftValue, rightValue] as const) : undefined;
}
