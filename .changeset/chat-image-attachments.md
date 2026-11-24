---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

The runtime SDK gains `artifacts.uploadBytes`. It computes the SHA-256 digest, creates the upload, sends the bytes to the presigned URL with only the signed headers, and completes the upload. It refuses a storage URL that is not HTTPS unless the host is loopback. `PlatformSdk` gains `uploadPresigned`, which the mock transport implements without sending bytes. Mock run submissions now echo `inputArtifacts` on the message.
