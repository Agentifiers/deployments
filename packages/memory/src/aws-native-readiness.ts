import type { OpenSearchTransport } from "./aws-native-contracts.ts";
import {
  AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
  openSearchReplicaSettingsReady,
} from "./aws-native-erasure.ts";
import { awsNativeRequest } from "./aws-native-errors.ts";

export async function reconcileOpenSearchReplicaSettings(args: {
  readonly embeddingDimensions: number;
  readonly index: unknown;
  readonly indexName: string;
  readonly openSearch: OpenSearchTransport;
  readonly signal?: AbortSignal;
}) {
  if (openSearchReplicaSettingsReady(args.index, args.embeddingDimensions)) return args.index;
  await awsNativeRequest("reconcile-open-search-replicas", () =>
    args.openSearch.request({
      body: AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
      method: "PUT",
      path: `/${encodeURIComponent(args.indexName)}/_settings`,
      ...(args.signal ? { signal: args.signal } : {}),
    }),
  );
  return awsNativeRequest("read-reconciled-open-search-readiness", () =>
    args.openSearch.request({
      method: "GET",
      path: `/${encodeURIComponent(args.indexName)}`,
      ...(args.signal ? { signal: args.signal } : {}),
    }),
  );
}
