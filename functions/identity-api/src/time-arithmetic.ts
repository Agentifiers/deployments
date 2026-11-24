export function plusSeconds(value: Date, seconds: number) {
  return new Date(value.getTime() + seconds * 1_000).toISOString();
}
