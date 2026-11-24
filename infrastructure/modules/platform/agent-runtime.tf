module "durable_streams" {
  count  = var.durable_streams_enabled ? 1 : 0
  source = "../durable-streams"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                         = module.ops_alerts.topic_arn
  compact_task_sizing_enabled             = var.operations.compact_sizing
  container_insights_enabled              = var.operations.enhanced_monitoring
  deletion_protection_enabled             = var.durable_streams_deletion_protection_enabled
  desired_count                           = var.durable_streams_desired_count
  environment                             = var.environment
  fargate_spot_enabled                    = var.operations.fargate_spot
  file_system_deletion_protection_enabled = var.operations.deletion_protection
  image                                   = var.durable_streams_image
  log_retention_in_days                   = var.operations.log_retention_days
  permissions_boundary_arn                = var.iam_permissions_boundary_arn
  private_subnet_ids                      = module.platform_network[0].private_subnet_ids
  secret_recovery_window_in_days          = var.operations.secret_recovery_window_days
  shared_load_balancer = {
    arn               = module.model_runtime[0].internal_load_balancer.arn
    arn_suffix        = module.model_runtime[0].internal_load_balancer.arn_suffix
    dns_name          = module.model_runtime[0].internal_load_balancer.dns_name
    security_group_id = module.model_runtime[0].internal_load_balancer.security_group_id
  }
  tags     = var.tags
  vpc_cidr = var.network_cidr_block
  vpc_id   = module.platform_network[0].vpc_id
}

locals {
  # Compact deployments run small single-task worker fleets; full sizing keeps
  # two tasks for availability and room to scale out under load.
  agent_worker_capacity = var.operations.compact_sizing ? {
    cpu                 = 512
    memory              = 1024
    max_concurrent_runs = 8
    min_count           = 1
    max_count           = 4
    } : {
    cpu                 = 1024
    memory              = 4096
    max_concurrent_runs = 16
    min_count           = 2
    max_count           = 20
  }
}

module "agent_runtime" {
  count  = var.agent_runtime_enabled ? 1 : 0
  source = "../agent-runtime"

  agent_worker_image                      = var.agent_worker_image
  alarms_enabled                          = module.ops_alerts.connected
  alarm_topic_arn                         = module.ops_alerts.topic_arn
  api_throttling_burst_limit              = var.operations.public_api_throttle.burst_limit
  api_throttling_rate_limit               = var.operations.public_api_throttle.rate_limit
  artifact_bucket_arn                     = module.platform_data.artifact_bucket_arn
  artifact_bucket_name                    = module.platform_data.artifact_bucket_name
  data_kms_key_arn                        = module.platform_data.kms_key_arn
  default_model_spend_ceiling_usd_micros  = var.default_model_spend_ceiling_usd_micros
  deletion_protection_enabled             = var.operations.deletion_protection
  document_extraction_function_arn        = module.document_extraction.function_arn
  document_extraction_function_name       = module.document_extraction.function_name
  durable_streams_auth_secret_arn         = module.durable_streams[0].auth_token_secret_arn
  durable_streams_base_url                = module.durable_streams[0].base_url
  ecs_cluster_arn                         = module.model_runtime[0].ecs_cluster_arn
  dynamodb_table_arns                     = local.shared_runtime_table_arns
  dynamodb_table_names                    = local.shared_runtime_table_names
  execution_table_stream_arn              = module.platform_data.table_stream_arns["execution"]
  environment                             = var.environment
  event_bus_name                          = module.platform_events[0].event_bus_name
  fargate_spot_enabled                    = var.operations.fargate_spot
  lambda_artifact_bucket                  = var.agent_runtime_artifact_bucket
  lambda_artifact_key                     = var.agent_runtime_artifact_key
  lambda_artifact_version                 = var.agent_runtime_artifact_version
  legacy_artifact_bucket_arns             = local.legacy_artifact_bucket_arns
  legacy_artifact_bucket_names            = local.legacy_artifact_bucket_names
  legacy_webhook_signing_secret_arns      = var.agent_runtime_legacy_webhook_signing_secret_arns
  log_retention_in_days                   = var.operations.log_retention_days
  model_catalog_bedrock_region            = contains(var.model_runtime_hosted_providers, "bedrock") ? var.aws_region : ""
  model_catalog_openai_api_key_secret_arn = local.openai_tailnet_relay_enabled ? "" : try(module.model_runtime[0].secret_arns["openai-api-key"], "")
  model_catalog_openai_model_ids          = local.openai_tailnet_relay_enabled ? var.model_runtime_openai_tailnet_upstream.model_ids : []
  model_credential_providers              = var.model_credential_providers
  model_gateway_base_url                  = module.model_runtime[0].model_gateway_base_url
  model_gateway_token_signing_key_arn     = module.model_runtime[0].token_signing_key_arn
  model_grants_parameter_arn              = module.model_runtime[0].model_grants_parameter_arn
  model_token_embedding_models            = [var.memory_runtime_embedding_model, var.web_tools_firecrawl_embedding_model_name]
  model_token_service_fallback_models     = var.model_gateway_service_fallback_model_ids
  model_token_service_models = {
    agent_worker = [var.brain_runtime_answer_model, var.memory_runtime_embedding_model, var.memory_runtime_rerank_model]
    brain        = [var.brain_runtime_answer_model, var.memory_runtime_embedding_model]
    memory       = [var.memory_runtime_embedding_model, var.memory_runtime_rerank_model]
    web_tools    = [var.web_tools_firecrawl_model_name, var.web_tools_firecrawl_embedding_model_name]
  }
  oauth_refresh_function_arn           = one(module.channel_provider_runtime[*].oauth_refresh_function_arn)
  oauth_refresh_function_name          = one(module.channel_provider_runtime[*].oauth_refresh_function_name)
  permissions_boundary_arn             = var.iam_permissions_boundary_arn
  private_subnet_ids                   = module.platform_network[0].private_subnet_ids
  request_admission_table_arn          = module.platform_data.request_admission_table_arn
  request_admission_table_name         = module.platform_data.request_admission_table_name
  stream_gateway_base_url              = module.stream_gateway[0].base_url
  worker_additional_security_group_ids = var.web_tools_runtime_enabled ? [aws_security_group.web_tools_client[0].id] : []
  worker_cpu                           = local.agent_worker_capacity.cpu
  worker_max_concurrent_runs           = local.agent_worker_capacity.max_concurrent_runs
  worker_max_count                     = local.agent_worker_capacity.max_count
  worker_memory                        = local.agent_worker_capacity.memory
  worker_min_count                     = local.agent_worker_capacity.min_count
  api_jwt_audience                     = var.platform_api_enabled ? local.api_jwt_audience : ""
  api_jwt_claim_profile                = local.api_jwt_claim_profile
  api_jwt_issuer                       = var.platform_api_enabled ? local.api_jwt_issuer : ""
  api_reserved_concurrency             = var.agent_runtime_api_reserved_concurrency
  webhook_events_reserved_concurrency  = var.agent_runtime_webhook_events_reserved_concurrency
  webhook_delivery_retention_days      = var.operations.webhook_delivery_retention_days
  runtime_environment_variables = merge(
    length(var.agent_runtime_browser_allowed_origins) == 0 ? {} : {
      DEPLOYMENTS_AI_BROWSER_SCREENSHOT_ALLOWED_ORIGINS = join(",", var.agent_runtime_browser_allowed_origins)
    },
    var.agent_runtime_browser_any_public_origin ? { DEPLOYMENTS_AI_BROWSER_ANY_PUBLIC_ORIGIN = "true" } : {},
    var.agent_runtime_web_tools_enabled ? {
      DEPLOYMENTS_AI_FIRECRAWL_BASE_URL              = var.web_tools_runtime_enabled ? module.web_tools_runtime[0].base_url : coalesce(var.agent_runtime_firecrawl_base_url, "")
      DEPLOYMENTS_AI_FIRECRAWL_DENY_PRIVATE_EGRESS   = "true"
      DEPLOYMENTS_AI_FIRECRAWL_JOB_TICKET_SECRET_ARN = var.web_tools_runtime_enabled ? module.web_tools_runtime[0].job_ticket_secret_arn : coalesce(var.agent_runtime_firecrawl_job_ticket_secret_arn, "")
      DEPLOYMENTS_AI_WEB_TOOLS_ENABLED               = "true"
    } : {},
    !var.agent_runtime_web_tools_enabled || var.agent_runtime_firecrawl_api_key_secret_arn == null ? {} : {
      DEPLOYMENTS_AI_FIRECRAWL_API_KEY_SECRET_ARN = var.agent_runtime_firecrawl_api_key_secret_arn
    },
    try(module.memory_runtime[0].worker_runtime_configuration, {}),
    try(module.brain_runtime[0].runtime_configuration, {}),
    coalesce(try(module.sandbox_runtime[0].lambda_microvm_runtime_configuration, null), tomap({})),
    try(module.app_runtime[0].callers.environment, {}),
  )
  runtime_policy_arns = merge(
    var.memory_runtime_enabled ? {
      memory_aws_native = module.memory_runtime[0].worker_aws_native_policy_arn
    } : {},
    length(module.brain_runtime) == 1 ? {
      brain_query = module.brain_runtime[0].query_policy_arn
    } : {},
    var.sandbox_lambda_microvm_enabled ? {
      sandbox_lambda_microvm = module.sandbox_runtime[0].lambda_microvm_runtime_policy_arn
    } : {},
    var.apps_enabled ? {
      apps_database_invoke = module.app_runtime[0].callers.invoke_policy_arn
      apps_dev_sessions    = module.app_runtime[0].callers.dev_session_policy_arn
      apps_release_upload  = module.app_runtime[0].callers.release_upload_policy_arn
    } : {},
  )
  runtime_secret_arns = compact([
    var.agent_runtime_web_tools_enabled ? var.agent_runtime_firecrawl_api_key_secret_arn : null,
    var.agent_runtime_web_tools_enabled ? (var.web_tools_runtime_enabled ? module.web_tools_runtime[0].job_ticket_secret_arn : var.agent_runtime_firecrawl_job_ticket_secret_arn) : null,
  ])
  tags                       = var.tags
  tenant_limit_defaults_json = jsonencode(var.operations.tenant_limit_defaults)
  usage_table_stream_arn     = module.platform_data.table_stream_arns["usage"]
  vpc_id                     = module.platform_network[0].vpc_id

  # Alert email links into the console, so alerts run only on installs that deploy it.
  alert_email = !var.alerts.enabled || !var.console_enabled ? {} : {
    console_origin           = var.platform_identity_application_origin
    observability_base_url   = try(module.agent_observability_hot[0].api_base_url, "")
    observability_secret_arn = try(module.agent_observability_hot[0].service_secret_arn, "")
    product_name             = var.alerts.product_name
    sender                   = coalesce(trimspace(var.alerts.email_sender), var.platform_identity_email_sender)
  }
}

module "model_runtime" {
  count  = var.model_runtime_enabled ? 1 : 0
  source = "../model-runtime"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                         = module.ops_alerts.topic_arn
  bifrost_desired_count                   = var.bifrost_desired_count
  bifrost_image                           = var.bifrost_image
  compact_task_sizing_enabled             = var.operations.compact_sizing
  container_insights_enabled              = var.operations.enhanced_monitoring
  control_table_arn                       = module.platform_data.table_arns["control"]
  control_table_name                      = module.platform_data.table_names["control"]
  default_model_spend_ceiling_usd_micros  = var.default_model_spend_ceiling_usd_micros
  deletion_protection_enabled             = var.operations.deletion_protection
  environment                             = var.environment
  execution_table_arn                     = local.shared_runtime_table_arns["execution"]
  execution_table_name                    = local.shared_runtime_table_names["execution"]
  hosted_providers                        = var.model_runtime_hosted_providers
  https_client_security_group_ids         = var.web_tools_runtime_enabled ? { web_tools = aws_security_group.web_tools_client[0].id } : {}
  kms_deletion_window_in_days             = var.operations.kms_deletion_window_days
  log_retention_in_days                   = var.operations.service_log_retention_days
  model_credentials                       = length(var.model_credential_providers) == 0 || !var.platform_api_enabled ? null : { kms_key_arn = module.platform_api[0].model_credential_kms_key_arn }
  model_gateway_image                     = var.model_gateway_image
  model_gateway_previous_signing_key_arns = var.model_gateway_previous_signing_key_arns
  openai_base_url                         = local.model_runtime_openai_base_url
  permissions_boundary_arn                = var.iam_permissions_boundary_arn
  private_subnet_ids                      = module.platform_network[0].private_subnet_ids
  secret_recovery_window_in_days          = var.operations.secret_recovery_window_days
  tags                                    = var.tags
  usage_table_arn                         = module.platform_data.table_arns["usage"]
  usage_table_name                        = module.platform_data.table_names["usage"]
  vpc_cidr                                = var.network_cidr_block
  vpc_id                                  = module.platform_network[0].vpc_id
}

module "sandbox_runtime" {
  count  = var.sandbox_lambda_microvm_enabled ? 1 : 0
  source = "../sandbox-runtime"

  environment                       = var.environment
  lambda_microvm_enabled            = var.sandbox_lambda_microvm_enabled
  lambda_microvm_execution_role_arn = var.lambda_microvm_execution_role_arn
  lambda_microvm_image_capacity     = var.lambda_microvm_image_capacity
  lambda_microvm_image_identifier   = var.lambda_microvm_image_identifier
  lambda_microvm_image_version      = var.lambda_microvm_image_version
  log_retention_in_days             = var.operations.log_retention_days
  permissions_boundary_arn          = var.iam_permissions_boundary_arn
  tags                              = var.tags
  usage_cost_policy                 = var.sandbox_usage_cost_policy
}
