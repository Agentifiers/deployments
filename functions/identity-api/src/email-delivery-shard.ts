export function deliveryShard(id: string) {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return String((hash >>> 0) % 16).padStart(2, "0");
}
