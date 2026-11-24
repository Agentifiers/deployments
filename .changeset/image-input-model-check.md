---
"@agentifiers/deployments-cli": patch
"@agentifiers/deployments-sdk": patch
---

A run submission whose `inputArtifacts` include an image now fails up front with `422 model_image_input_unsupported` when the release's primary model cannot read images, or `422 model_image_input_unknown` when the platform cannot tell (for example a model admitted only by an operator grant). Before, the run was queued and failed later at the provider. Audio-only input is unaffected. When a run with images starts, fallback models that cannot read images are left out of that run.
