import type { OpenSearchTransport } from "./aws-native-contracts.ts";

type OpenSearchRequest = Parameters<OpenSearchTransport["request"]>[0];

function indexNotFound(index: string) {
  const error = { index, reason: `no such index [${index}]`, type: "index_not_found_exception" };
  return Object.assign(new Error("OpenSearch request failed with status 404."), {
    details: { error, status: 404 },
    status: 404,
  });
}

export function scriptedPurgeOpenSearch(index: string) {
  const requests: OpenSearchRequest[] = [];
  const script = {
    deleteTaskComplete: true,
    forceMergeTaskComplete: true,
    indexAbsent: false,
  };
  const transport: OpenSearchTransport = {
    request: async (input) => {
      requests.push(input);
      if (script.indexAbsent) throw indexNotFound(index);
      const { path } = input;
      if (input.method === "GET" && path === `/${index}`) return { [index]: {} };
      if (path.startsWith(`/${index}/_delete_by_query`)) return { task: "delete-task" };
      if (path.startsWith(`/${index}/_forcemerge`)) return { task: "merge-task" };
      if (path === "/_tasks/delete-task") {
        return script.deleteTaskComplete
          ? {
              completed: true,
              response: { deleted: 2, failures: [], timed_out: false, version_conflicts: 0 },
            }
          : { completed: false };
      }
      if (path === "/_tasks/merge-task") {
        return script.forceMergeTaskComplete
          ? { completed: true, response: { _shards: { failed: 0 } } }
          : { completed: false };
      }
      if (path.startsWith("/.tasks/_doc/")) return { result: "deleted" };
      if (path === `/${index}/_segments`) {
        return {
          _shards: { failed: 0, successful: 1, total: 1 },
          indices: { [index]: { shards: { "0": [{ segments: { _0: { deleted_docs: 0 } } }] } } },
        };
      }
      if (path.startsWith(`/${index}/_flush`)) return { _shards: { failed: 0 } };
      if (path.startsWith(`/${index}/_stats/`)) {
        const translog = { translog: { operations: 0, uncommitted_operations: 0 } };
        return {
          _shards: { failed: 0 },
          indices: { [index]: { primaries: translog, total: translog } },
        };
      }
      // Amazon OpenSearch Service always lists its own automated repository.
      if (path === "/_snapshot/_all") return { "cs-automated-enc": { type: "s3" } };
      if (path === `/${index}/_search`) {
        return { _shards: { failed: 0 }, hits: { total: { value: 0 } }, timed_out: false };
      }
      throw new Error(`Unscripted OpenSearch request ${input.method} ${path}`);
    },
  };
  return { requests, script, transport };
}

export function droppedIndexOpenSearch(
  index: string,
  savedTask: "failed" | "expired" | "completed" = "failed",
) {
  const requests: string[] = [];
  let submitted = 0;
  const transport: OpenSearchTransport = {
    request: async ({ method, path }) => {
      requests.push(`${method} ${path}`);
      if (method === "GET" && path === `/${index}`) throw indexNotFound(index);
      if (
        method === "POST" &&
        (path.startsWith(`/${index}/_delete_by_query`) || path.startsWith(`/${index}/_forcemerge`))
      ) {
        submitted += 1;
        return { task: `node:${submitted}` };
      }
      if (method === "GET" && path.startsWith("/_tasks/")) {
        if (savedTask === "expired") {
          throw Object.assign(new Error("OpenSearch request failed with status 404."), {
            details: { error: { type: "resource_not_found_exception" }, status: 404 },
            status: 404,
          });
        }
        return savedTask === "failed"
          ? { completed: true, error: indexNotFound(index).details.error }
          : {
              completed: true,
              response: { deleted: 0, failures: [], timed_out: false, version_conflicts: 0 },
            };
      }
      if (method === "DELETE" && path.startsWith("/.tasks/_doc/")) return { result: "deleted" };
      throw new Error(`Unscripted OpenSearch request ${method} ${path}`);
    },
  };
  return { requests, transport };
}
