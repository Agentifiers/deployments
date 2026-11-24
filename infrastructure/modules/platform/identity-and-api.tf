locals {
  platform_identity_published = var.platform_identity_enabled && var.platform_identity_publish_domain
  platform_identity_issuer    = "https://${var.platform_identity_domain_name}"

  # Runtimes that trust the published platform identity domain replace their explicit JWT settings.
  runtime_jwt_uses_platform_identity = var.runtime_jwt_from_platform_identity && local.platform_identity_published
  memory_jwt_audiences               = local.runtime_jwt_uses_platform_identity ? [var.platform_identity_resource_audience] : var.memory_runtime_jwt_audience
  memory_jwt_issuer                  = local.runtime_jwt_uses_platform_identity ? local.platform_identity_issuer : var.memory_runtime_jwt_issuer
  memory_jwt_jwks_uri                = local.runtime_jwt_uses_platform_identity ? module.platform_identity[0].jwks_uri : var.memory_runtime_jwks_uri
  channel_provider_jwt_audiences     = local.runtime_jwt_uses_platform_identity ? [var.platform_identity_resource_audience] : var.channel_provider_jwt_audience
  channel_provider_jwt_issuer        = local.runtime_jwt_uses_platform_identity ? local.platform_identity_issuer : var.channel_provider_jwt_issuer
  oauth_return_origins               = distinct(concat(var.channel_provider_oauth_return_origins, var.console_enabled ? [var.platform_identity_application_origin] : []))

  api_jwt_audience      = local.platform_identity_published ? var.platform_identity_resource_audience : var.platform_api_jwt_audience
  api_jwt_claim_profile = local.platform_identity_published ? "platform" : "auto"
  api_jwt_issuer        = local.platform_identity_published ? local.platform_identity_issuer : var.platform_api_jwt_issuer

  apps_reserved_hostnames = compact([
    var.platform_api_domain_name,
    var.platform_identity_domain_name,
    split(":", trimprefix(var.platform_identity_application_origin, "https://"))[0],
    var.stream_gateway_domain_name,
  ])
  platform_api_apps_runtime = var.apps_enabled ? merge(module.app_runtime[0].callers, {
    domain_reconciler_invoke_policy_arn = module.app_runtime[0].domain_reconciler_invoke_policy_arn
    environment = merge(module.app_runtime[0].callers.environment, {
      APPS_CUSTOM_DOMAIN_TARGET            = module.app_runtime[0].custom_domains.routing_endpoint
      APPS_DOMAIN_RECONCILER_FUNCTION_NAME = module.app_runtime[0].domain_reconciler_function_name
      APPS_RESERVED_HOSTNAMES              = join(",", local.apps_reserved_hostnames)
    })
  }) : null
}

module "platform_identity" {
  count  = var.platform_identity_enabled ? 1 : 0
  source = "../platform-identity"

  additional_clients               = var.platform_identity_additional_clients
  alarms_enabled                   = module.ops_alerts.connected
  alarm_topic_arn                  = module.ops_alerts.topic_arn
  api_artifact_bucket              = var.platform_identity_api_artifact_bucket
  api_artifact_key                 = var.platform_identity_api_artifact_key
  api_artifact_version             = var.platform_identity_api_artifact_version
  api_reserved_concurrency         = var.platform_identity_api_reserved_concurrency
  application_origin               = var.platform_identity_application_origin
  certificate_arn                  = var.platform_identity_certificate_arn
  cli_redirect_uris                = var.platform_identity_cli_redirect_uris
  control_table_arn                = module.platform_data.table_arns["control"]
  control_table_name               = module.platform_data.table_names["control"]
  data_kms_key_arn                 = module.platform_data.kms_key_arn
  deletion_protection_enabled      = var.operations.deletion_protection
  deploying_role_name              = var.deploying_role_name
  detailed_metrics_enabled         = var.operations.enhanced_monitoring
  domain_name                      = var.platform_identity_domain_name
  e2e_client_enabled               = var.operations.test_fixtures
  email_artifact_bucket            = var.platform_identity_email_artifact_bucket
  email_artifact_key               = var.platform_identity_email_artifact_key
  email_artifact_version           = var.platform_identity_email_artifact_version
  email_sender                     = var.platform_identity_email_sender
  environment                      = var.environment
  events_table_arn                 = module.platform_data.table_arns["events"]
  events_table_name                = module.platform_data.table_names["events"]
  human_verification               = var.platform_identity_human_verification
  identity_email_stream_arn        = module.platform_data.table_stream_arns["identity-email-outbox"]
  identity_email_table_arn         = module.platform_data.table_arns["identity-email-outbox"]
  identity_email_table_name        = module.platform_data.table_names["identity-email-outbox"]
  identity_table_arn               = module.platform_data.table_arns["identity"]
  identity_table_name              = module.platform_data.table_names["identity"]
  kms_deletion_window_in_days      = var.operations.kms_deletion_window_days
  log_retention_in_days            = var.operations.log_retention_days
  permissions_boundary_arn         = var.iam_permissions_boundary_arn
  publish_domain                   = var.platform_identity_publish_domain
  registration_enabled             = var.platform_identity_registration_enabled
  resource_audience                = var.platform_identity_resource_audience
  route53_zone_id                  = var.platform_identity_route53_zone_id
  tags                             = var.tags
  web_application_firewall_enabled = var.operations.web_application_firewall
  web_redirect_uris                = var.platform_identity_web_redirect_uris
}

module "platform_api" {
  count  = var.platform_api_enabled ? 1 : 0
  source = "../platform-api"

  depends_on = [module.platform_identity]

  account_id                                 = var.aws_account_id
  agent_email_api_enabled                    = var.agent_email_enable_runtime && trimspace(var.agent_email_artifact_bucket) != "" && trimspace(var.agent_email_artifact_key) != "" && trimspace(var.agent_email_artifact_version) != ""
  agent_email_api_function_name              = module.agent_email.api_function_name == null ? "" : module.agent_email.api_function_name
  agent_email_api_invoke_arn                 = module.agent_email.api_invoke_arn == null ? "" : module.agent_email.api_invoke_arn
  agent_email_bucket_arn                     = module.agent_email.bucket_arn
  agent_email_bucket_name                    = module.agent_email.bucket_name
  legacy_agent_email_bucket_arns             = local.legacy_agent_email_bucket_arns
  legacy_agent_email_bucket_names            = local.legacy_agent_email_bucket_names
  agent_observability_quarantine_bucket_arn  = try(module.agent_observability[0].quarantine_bucket_arn, null)
  agent_observability_quarantine_bucket_name = try(module.agent_observability[0].quarantine_bucket_name, null)
  alarms_enabled                             = module.ops_alerts.connected
  alarm_topic_arn                            = module.ops_alerts.topic_arn
  apps_runtime                               = local.platform_api_apps_runtime
  artifact_bucket                            = var.platform_api_artifact_bucket
  artifact_key                               = var.platform_api_artifact_key
  artifact_version                           = var.platform_api_artifact_version
  automation_scheduler_group_name            = module.agent_runtime[0].scheduler_group_name
  brain_runtime_environment_variables        = merge(try(module.brain_runtime[0].runtime_configuration, {}), { DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS = join(",", var.model_gateway_service_fallback_model_ids) })
  brain_runtime_policy_arn                   = try(module.brain_runtime[0].query_policy_arn, "")
  brain_erasure_function_arn                 = module.brain_runtime[0].erasure_function_arn
  brain_erasure_function_name                = module.brain_runtime[0].erasure_function_name
  certificate_arn                            = var.platform_api_certificate_arn
  control_table_arn                          = module.platform_data.table_arns["control"]
  control_table_name                         = module.platform_data.table_names["control"]
  device_authorization_client_id             = local.platform_identity_published ? "deployments-cli" : var.platform_api_device_authorization_client_id
  device_authorization_issuer                = local.platform_identity_published ? local.platform_identity_issuer : var.platform_api_device_authorization_issuer
  detailed_metrics_enabled                   = var.operations.enhanced_monitoring
  data_kms_key_arn                           = module.platform_data.kms_key_arn
  default_model_spend_ceiling_usd_micros     = var.default_model_spend_ceiling_usd_micros
  dynamodb_table_arns                        = local.shared_runtime_table_arns
  dynamodb_table_names                       = local.shared_runtime_table_names
  domain_name                                = var.platform_api_domain_name
  durable_streams_auth_secret_arn            = module.durable_streams[0].auth_token_secret_arn
  durable_streams_base_url                   = module.durable_streams[0].base_url
  e2e_callback_fixture_enabled               = var.platform_api_e2e_callback_fixture_enabled
  e2e_mcp_fixture_enabled                    = var.platform_api_e2e_mcp_fixture_enabled
  environment                                = var.environment
  evaluation_queue_arn                       = module.agent_runtime[0].evaluation_queue_arn
  evaluation_queue_url                       = module.agent_runtime[0].evaluation_queue_url
  events_table_arn                           = module.platform_data.table_arns["events"]
  events_table_name                          = module.platform_data.table_names["events"]
  governance_bucket_arn                      = module.platform_data.governance_bucket_arn
  governance_bucket_name                     = module.platform_data.governance_bucket_name
  legacy_governance_bucket_arns              = local.legacy_governance_bucket_arns
  legacy_governance_bucket_names             = local.legacy_governance_bucket_names
  governance_signing_key_arn                 = module.platform_data.governance_signing_key_arn
  identity_email_kms_key_arn                 = var.platform_identity_enabled ? module.platform_data.kms_key_arn : ""
  identity_email_table_arn                   = module.platform_data.table_arns["identity-email-outbox"]
  identity_email_table_name                  = module.platform_data.table_names["identity-email-outbox"]
  identity_federation                        = var.platform_identity_enabled ? { kms_key_arn = module.platform_identity[0].federation_kms_key_arn } : null
  identity_table_arn                         = module.platform_data.table_arns["identity"]
  identity_table_name                        = module.platform_data.table_names["identity"]
  jwt_audience                               = local.api_jwt_audience
  jwt_claim_profile                          = local.api_jwt_claim_profile
  jwt_issuer                                 = local.api_jwt_issuer
  log_retention_in_days                      = var.operations.log_retention_days
  memory_api_function_name                   = module.memory_runtime[0].api_function_name
  memory_api_invoke_arn                      = module.memory_runtime[0].api_function_invoke_arn
  memory_erasure_function_arn                = module.memory_runtime[0].erasure_function_arn
  memory_erasure_function_name               = module.memory_runtime[0].erasure_function_name
  memory_jwt_audience                        = local.memory_jwt_audiences
  memory_jwt_issuer                          = local.memory_jwt_issuer
  memory_jwt_jwks_uri                        = local.memory_jwt_jwks_uri
  model_credentials                          = length(var.model_credential_providers) == 0 ? null : { deletion_protection_enabled = var.operations.deletion_protection, gateway_role_arn = try(module.model_runtime[0].task_role_arn, null), kms_deletion_window_in_days = var.operations.kms_deletion_window_days, providers = var.model_credential_providers }
  model_gateway_base_url                     = try(module.model_runtime[0].model_gateway_base_url, "")
  model_gateway_token_issuer                 = var.agent_runtime_enabled ? module.agent_runtime[0].model_token_issuers["brain"] : null
  model_grants_parameter_arn                 = try(module.model_runtime[0].model_grants_parameter_arn, "")
  network                                    = local.private_network
  oauth_apps_json                            = var.channel_provider_oauth_apps_json
  oauth_public_origin                        = one(module.channel_provider_runtime[*].oauth_public_origin)
  oauth_refresh_function_arn                 = one(module.channel_provider_runtime[*].oauth_refresh_function_arn)
  oauth_refresh_function_name                = one(module.channel_provider_runtime[*].oauth_refresh_function_name)
  oauth_return_origins                       = local.oauth_return_origins
  organization_creation_quota_per_principal  = var.organization_creation_quota_per_principal
  observability_base_url                     = try(module.agent_observability_hot[0].api_base_url, "")
  observability_erasure_function_arn         = try(module.agent_observability[0].erasure_function_arn, "")
  observability_erasure_function_name        = try(module.agent_observability[0].erasure_function_name, "")
  observability_secret_arn                   = try(module.agent_observability_hot[0].service_secret_arn, "")
  observability_secret_version_id            = try(module.agent_observability_hot[0].service_secret_version_id, "")
  permissions_boundary_arn                   = var.iam_permissions_boundary_arn
  platform_artifact_bucket_arn               = module.platform_data.artifact_bucket_arn
  platform_artifact_bucket_name              = module.platform_data.artifact_bucket_name
  legacy_platform_artifact_bucket_arns       = local.legacy_artifact_bucket_arns
  legacy_platform_artifact_bucket_names      = local.legacy_artifact_bucket_names
  principal_status_function = var.platform_identity_enabled ? {
    arn  = module.platform_identity[0].principal_status_function_arn
    name = module.platform_identity[0].principal_status_function_name
  } : null
  request_admission_table_arn       = module.platform_data.request_admission_table_arn
  request_admission_table_name      = module.platform_data.request_admission_table_name
  reserved_concurrency              = var.platform_api_reserved_concurrency
  route53_zone_id                   = var.platform_api_route53_zone_id
  runtime_api_function_name         = module.agent_runtime[0].api_function_name
  runtime_api_invoke_arn            = module.agent_runtime[0].api_function_invoke_arn
  system_alarm_name_prefix          = var.system_alarm_name_prefix
  system_bedrock_region             = try(module.model_runtime[0].bedrock_region, null)
  system_ecs_services               = local.system_ecs_services
  system_model_provider_secret_arns = local.system_model_provider_secret_arns
  system_observability              = local.system_observability
  system_observer_role_arns         = var.system_observer_role_arns
  system_service_principals         = var.system_service_principals
  tags                              = var.tags
  test_fixtures_enabled             = var.operations.test_fixtures
  tenant_limit_defaults_json        = jsonencode(var.operations.tenant_limit_defaults)
  throttling_burst_limit            = var.operations.public_api_throttle.burst_limit
  throttling_rate_limit             = var.operations.public_api_throttle.rate_limit
  usage_table_arn                   = module.platform_data.table_arns["usage"]
  usage_table_name                  = module.platform_data.table_names["usage"]
}
