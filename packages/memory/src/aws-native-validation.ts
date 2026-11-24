import type { AwsNativeMemoryConfig } from "./aws-native-contracts.ts";

export function validateAwsNativeEmbedding(
  config: AwsNativeMemoryConfig,
  embedding: readonly number[],
) {
  if (
    embedding.length !== config.embeddingDimensions ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError(
      `Memory embedding must contain ${config.embeddingDimensions} finite values.`,
    );
  }
}

export function validateAwsNativeTimestamp(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("Canonical memory timestamp is invalid.");
  return parsed;
}
