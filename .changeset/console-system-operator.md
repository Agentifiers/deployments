---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Install operators can read the deployed release and install health. The SDK adds `getSystemInstallation`, `listSystemDeployments`, `getSystemComponents`, `listSystemAlarms`, `listSystemModelProviders`, and `listSystemOrganizations` (`GET /v1/system/*`), served only to platform administrators signed in through platform identity; API keys receive 403. The CLI adds `deployments system installation|deployments|components|alarms|model-providers|organizations`.
