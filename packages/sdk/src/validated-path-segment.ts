/** Encodes a caller-supplied id as one URL path segment, rejecting blank and dot segments. */
export function segment(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new TypeError(`${name} must not be empty.`);
  }
  return encodeURIComponent(normalized);
}
