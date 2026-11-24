---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

A person signed in with platform credentials can now submit a run whose `inputArtifacts` are their own private uploads on the run's thread, and can retry and replay that run. Before, only service accounts could attach input artifacts. Artifacts uploaded by another person or by a service account still fail with `input_artifact_unavailable`, and so does a retry or replay by anyone other than the caller that submitted the run.
