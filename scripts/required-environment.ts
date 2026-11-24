/** Returns the trimmed environment variable, failing fast when it is unset or blank. */
export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
