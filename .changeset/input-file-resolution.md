---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Completing an upload with `type: "input"` now reads the file, and the artifact response carries `input`. `input.kind` is `image` or `audio` for media typed from the file's bytes, `document` with a `summary` for a PDF, Word, Excel, CSV, text, Markdown, JSON, HTML, or ZIP file whose text was extracted, or `unusable` with a `reason` and a `message` that says why the file can't be attached. A `type: "input"` upload must be `private` and at most 10 MiB: a larger one fails at creation with `413 input_file_too_large`, and an `organization` one with `400 invalid_artifact_visibility`. When the platform can't read the file for a reason unrelated to the file, completion answers `503 input_file_resolution_unavailable` and the artifact stays `pending`, so completing it again retries.
