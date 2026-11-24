---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Thread streams are now served by the stream gateway. `threads.createStreamSession` responses include an absolute `streamUrl`, `threads.readStreamPage` now takes the session (`{ accessToken, streamUrl }`) instead of a thread ID, and the new `threads.streamEvents` async iterator reads Server-Sent Events and resumes from the last offset when the server closes the connection. Reads are no longer limited to 29 seconds or 4 MiB. `assistant-token.chunk` events now carry `{ modelCallId, sequence, text }`; render the latest `modelCallId`'s text and let `assistant-message.finalized` replace it. CLI follow mode (`run` output and `deployments dev`) streams model text live over SSE.
