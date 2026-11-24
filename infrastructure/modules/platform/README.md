# infrastructure/modules/platform

Composition module for one platform installation. It owns almost no resources itself: it calls the
component modules below, gates most of them on feature flags, and wires their outputs together
(shared DynamoDB tables, the data KMS key, the ops-alerts topic, the private network, JWT issuer
settings, and cross-component queues and functions). Components that create IAM roles receive
`iam_permissions_boundary_arn`, and per-component settings (deletion protection, retention,
monitoring, sizing, test fixtures, throttling, and similar) come from the deployment-wide
`operations` object.

## Component map

| Module block               | Source                        | Created when                                                                                | Role                                                                                            |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ops_alerts`               | `../ops-alerts`               | always                                                                                      | SNS ops-alerts topic (data-key encrypted) with email/Slack notification; every alarm targets it |
| `platform_data`            | `../platform-data`            | always                                                                                      | Data KMS key, shared DynamoDB tables, artifact and governance buckets, S3 Tables                |
| `platform_network`         | `../network`                  | any VPC-attached component is enabled (`local.platform_network_enabled`)                    | VPC, subnets, NAT, S3/DynamoDB gateway endpoints                                                |
| `platform_events`          | `../platform-events`          | `enable_platform_events`                                                                    | DynamoDB Streams to EventBridge semantic event dispatcher                                       |
| `platform_identity`        | `../platform-identity`        | `platform_identity_enabled`                                                                 | OAuth/OIDC identity provider and its email pipeline                                             |
| `platform_api`             | `../platform-api`             | `platform_api_enabled`                                                                      | Unified public product API and governance worker                                                |
| `durable_streams`          | `../durable-streams`          | `durable_streams_enabled` (default true)                                                    | Private Durable Streams ECS service on EFS behind a load balancer                               |
| `agent_runtime`            | `../agent-runtime`            | `agent_runtime_enabled`                                                                     | Queue-backed hosted agent runtime (SQS, Lambdas, worker service)                                |
| `model_runtime`            | `../model-runtime`            | `model_runtime_enabled` (default true)                                                      | Model gateway and Bifrost with the shared internal load balancer                                |
| `openai_tailnet_relay`     | `../tailnet-relay`            | model runtime on and `model_runtime_openai_tailnet_upstream` set                            | EC2 Tailscale relay giving the model gateway a private upstream                                 |
| `sandbox_runtime`          | `../sandbox-runtime`          | `sandbox_lambda_microvm_enabled`                                                            | Lambda MicroVM prerequisites                                                                    |
| `stream_gateway`           | `../stream-gateway`           | `agent_runtime_enabled`                                                                     | Public stream gateway for thread streams (ACM, Route 53, ECS)                                   |
| `web_tools_runtime`        | `../web-tools-runtime`        | `web_tools_runtime_enabled`                                                                 | Private self-hosted Firecrawl and Chromium renderer services                                    |
| `document_extraction`      | `../document-extraction`      | always (VPC-attached only with `agent_runtime_enabled`)                                     | Document text extraction Lambda, with Textract OCR when `document_extraction_ocr_enabled`       |
| `channel_provider_runtime` | `../channel-provider-runtime` | `channel_provider_runtime_enabled`                                                          | Channel ingress, delivery, provider tools, and credential vault                                 |
| `inbound_runtime`          | `../inbound-runtime`          | agent runtime and channel provider runtime both on                                          | Inbound channel processing that feeds the agent run queue                                       |
| `agent_email`              | `../agent-email`              | always (runtime gated by `agent_email_enable_runtime`)                                      | SES receiving/sending, agent email API and workers                                              |
| `search_domain`            | `../search-domain`            | one per enabled search runtime, or one shared domain with `operations.shared_search_domain` | OpenSearch domain for memory and brain indexes                                                  |
| `memory_runtime`           | `../memory-runtime`           | `memory_runtime_enabled`                                                                    | Public memory API and workers                                                                   |
| `brain_runtime`            | `../brain-runtime`            | platform API and agent runtime both on                                                      | Brain indexing, content maintenance, and erasure Lambdas and queues                             |
| `event_analytics`          | `../event-analytics`          | `event_analytics_lifecycle` is `running`, `stopped`, or `decommissioning`                   | Semantic event projector into S3 Tables, Athena workgroup and named queries                     |
| `agent_observability`      | `../agent-observability`      | `agent_observability_history_enabled`                                                       | Observability cold-history pipeline (Kinesis, Firehose, Athena, erasure)                        |
| `agent_observability_hot`  | `../observability-clickhouse` | `agent_observability_hot_enabled`                                                           | ClickHouse observability hot plane on EC2/EBS with an ECS service                               |
| `app_runtime`              | `../app-runtime`              | `apps_enabled`                                                                              | Runtime for agent-built apps (CloudFront, ECS gateway, Aurora, Lambdas)                         |
| `console`                  | `../console`                  | `console_enabled`                                                                           | Management console (S3 assets, CloudFront, HTTP API, Lambda)                                    |

`environments/customer` calls this module; variables are split by area across
`variables-*.tf`. Bun tests under `tests/` read its source.
