export function required(value: string | undefined, label: string) {
  const result = value?.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}
