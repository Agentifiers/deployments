---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

Send presigned storage uploads without the platform credential. `uploadPresigned`, `artifacts.uploadBytes` and `uploadBrainContent` used the `fetch` passed to `createPlatformSdk`, so a `fetch` that adds an `authorization` header sent it to storage, which rejects a second credential next to the URL signature. They now send exactly the signed headers through the new `storageFetch` option, which defaults to the global `fetch`.
