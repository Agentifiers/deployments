import {
  AwsNativeMemoryError,
  type AwsNativeMemoryConfig,
  type OpenSearchTransport,
} from "./aws-native-contracts.ts";
import type { CanonicalMemoryRecord } from "./memory-record.ts";

function isMissingOpenSearchDocument(cause: unknown) {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "status" in cause &&
    (cause as { readonly status?: unknown }).status === 404
  );
}

function requireOpenSearchDocumentDeleted(value: unknown) {
  const result =
    value !== null && typeof value === "object" && "result" in value
      ? (value as { readonly result?: unknown }).result
      : undefined;
  if (result !== "deleted" && result !== "not_found") {
    throw new AwsNativeMemoryError({
      cause: value,
      message: "OpenSearch did not confirm physical evidence deletion.",
      operation: "delete-evidence",
    });
  }
}

export async function deleteAwsNativeEvidence(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly memory: CanonicalMemoryRecord;
  readonly openSearch: OpenSearchTransport;
  readonly signal?: AbortSignal;
}) {
  try {
    const result = await args.openSearch.request({
      method: "DELETE",
      path: `/${encodeURIComponent(args.config.openSearchIndex)}/_doc/${encodeURIComponent(args.memory.data.id)}?refresh=wait_for&routing=${encodeURIComponent(args.memory.data.organizationId)}`,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    requireOpenSearchDocumentDeleted(result);
  } catch (cause) {
    if (!isMissingOpenSearchDocument(cause)) {
      throw cause instanceof AwsNativeMemoryError
        ? cause
        : new AwsNativeMemoryError({
            cause,
            message: "OpenSearch evidence deletion failed.",
            operation: "delete-evidence-open-search",
          });
    }
  }
  return { status: "synchronized" as const };
}
