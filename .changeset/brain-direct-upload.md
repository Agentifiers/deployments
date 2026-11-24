---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Brain content uploads now reach the documented 8 MiB. Before, the content `PUT` refused files above about 4.7 MB with `413`, because the body is base64-encoded into Lambda's 6 MB request payload. An issued upload ticket now includes `directUpload`, a presigned storage `PUT` and the `completePath` to call after it. The new SDK helper `uploadBrainContent` stores the bytes through `directUpload` and completes the ticket, or falls back to the content `PUT` for a ticket without `directUpload`. Resending with the same idempotency key converges. `deployments brain-upload content` uses it, and the new `deployments brain-upload complete` completes a ticket whose content was stored through its direct upload. The content `PUT` still works for existing clients.
