---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Usage and cost summaries: `GET /v1/usage/summary` (`usage:read`) and `GET /v1/costs/summary` (`spend:read`) return one zero-filled series per metric over an hour- or day-aligned `since`/`until` window (`interval` `hour` by default or `day`; at most 744 hourly or 366 daily buckets), with token splits for model tokens and costs in nanodollars, so a period needs one request instead of every ledger record. The CLI adds `deployments usage summary` and `deployments cost summary`. `GET /v1/usage`, `/v1/costs`, `/v1/spend`, and `/v1/api-key-usage` accept a `limit` of up to 1,000 (default still 100), and `usage show`, `cost show`, `spend show`, and `api-key usage` accept `--page-size` up to 1,000. Spend and API-key activity lists read the environment's metric index instead of its whole usage partition.
