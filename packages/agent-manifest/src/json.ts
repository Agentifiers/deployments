export function jsonValueDepthExceeds(input: unknown, maximumDepth: number): boolean {
  const stack: Array<{ readonly depth: number; readonly value: unknown }> = [
    { depth: 1, value: input },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth > maximumDepth) return true;
    for (const item of Object.values(current.value)) {
      stack.push({ depth: current.depth + 1, value: item });
    }
  }
  return false;
}

export function isJsonValueWithinDepth(input: unknown, maximumDepth: number): boolean {
  const stack: Array<{ readonly depth: number; readonly value: unknown }> = [
    { depth: 1, value: input },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const value = current.value;
    if (value === null || typeof value === "boolean" || typeof value === "string") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        return false;
      }
      continue;
    }
    if (typeof value !== "object" || current.depth > maximumDepth) return false;
    if (!Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    for (const item of Object.values(value)) {
      stack.push({ depth: current.depth + 1, value: item });
    }
  }
  return true;
}
