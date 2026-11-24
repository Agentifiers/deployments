---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

Memory and Brain search telemetry not tied to a run or thread, and semantic events other than a thread's, now expire at most 48 hours after their retention deadline. Recall attempts, memory retrievals, Brain query attempts, and Brain retrievals follow the `runs` period, and events follow `events`. Lengthening either period raises the expiry of records already written, and shortening one still removes older records at the next daily sweep. After a record expires, `recordMemoryRetrievalFeedback` (`POST /v1/memory/:memoryId/retrievals/:retrievalId/feedback`, CLI `deployments memory-retrieval feedback`) answers `404 retrieval_not_found`, `recordBrainFeedback` (`POST /v1/brains/query-attempts/:queryAttemptId/feedback`) answers `brain_query_attempt_not_found`, and memory quality leaves the record out.
