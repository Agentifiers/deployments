output "data_kms_key_arn" {
  value = module.platform_data.kms_key_arn
}

output "artifact_bucket_arn" {
  value = module.platform_data.artifact_bucket_arn
}

output "artifact_bucket_name" {
  value = module.platform_data.artifact_bucket_name
}

output "platform_api_endpoint" {
  value = try(module.platform_api[0].api_endpoint, null)
}

output "platform_api_function_arn" {
  value = try(module.platform_api[0].function_arn, null)
}

output "model_credential_kms_key_arn" {
  value = try(module.platform_api[0].model_credential_kms_key_arn, null)
}

output "platform_identity_function_arns" {
  value = try(module.platform_identity[0].function_arns, null)
}

output "platform_identity_bootstrap" {
  value = try(module.platform_identity[0].client_bootstrap, null)
}

output "dynamodb_table_arns" {
  value = module.platform_data.table_arns
}

output "dynamodb_table_names" {
  value = module.platform_data.table_names
}

output "dynamodb_table_stream_arns" {
  value = module.platform_data.table_stream_arns
}

output "channel_provider_api_endpoint" {
  value = try(module.channel_provider_runtime[0].api_endpoint, null)
}

output "channel_provider_delivery_role_arn" {
  description = "Platform principal that vertical-owned RCS delivery roles must trust."
  value       = try(module.channel_provider_runtime[0].channel_delivery_role_arn, null)
}

output "channel_provider_credential_writer_policy_arn" {
  value = try(module.channel_provider_runtime[0].credential_writer_policy_arn, null)
}

output "channel_provider_credential_vault_role_arns" {
  value = try(module.channel_provider_runtime[0].credential_vault_role_arns, {})
}

output "channel_provider_queue_arns" {
  value = try(module.channel_provider_runtime[0].queue_arns, {})
}

output "memory_api_endpoint" {
  value = try(module.memory_runtime[0].api_endpoint, null)
}

output "memory_queue_arns" {
  value = try(module.memory_runtime[0].queue_arns, {})
}

output "search_placement_functions" {
  description = "Functions that activate default memory and Brain search; the deploy tool runs them for every organization after each deploy."
  value = {
    brain  = try(module.brain_runtime[0].search_placement_function_name, null)
    memory = try(module.memory_runtime[0].search_placement_function_name, null)
  }
}

output "durable_streams_auth_token_secret_arn" {
  value = try(module.durable_streams[0].auth_token_secret_arn, null)
}

output "durable_streams_base_url" {
  value = try(module.durable_streams[0].base_url, null)
}

output "durable_streams_cluster_arn" {
  value = try(module.durable_streams[0].cluster_arn, null)
}

output "durable_streams_service_name" {
  value = try(module.durable_streams[0].service_name, null)
}

output "model_runtime_bedrock_region" {
  value = try(module.model_runtime[0].bedrock_region, null)
}

output "model_gateway_base_url" {
  value = try(module.model_runtime[0].model_gateway_base_url, null)
}

output "model_runtime_cluster_arn" {
  value = try(module.model_runtime[0].ecs_cluster_arn, null)
}

output "model_runtime_hosted_providers" {
  value = try(module.model_runtime[0].hosted_providers, null)
}

output "model_runtime_service_name" {
  value = try(module.model_runtime[0].service_name, null)
}

output "model_runtime_secret_arns" {
  # A conditional, unlike try(), keeps per-key unknowns visible while the parameters are being created.
  value = var.model_runtime_enabled ? module.model_runtime[0].secret_arns : {}
}

output "model_runtime_vpc_id" {
  value = try(module.platform_network[0].vpc_id, null)
}

output "model_runtime_openai_tailnet_relay" {
  description = "Tailnet relay serving the openai provider, or null when the provider uses api.openai.com."
  value = local.openai_tailnet_relay_enabled ? {
    auth_key_parameter_name = module.openai_tailnet_relay[0].auth_key_parameter_name
    instance_id             = module.openai_tailnet_relay[0].instance_id
    tailnet_hostname        = module.openai_tailnet_relay[0].tailnet_hostname
  } : null
}

output "web_tools_runtime" {
  description = "Private Firecrawl runtime deployment metadata."
  value = var.web_tools_runtime_enabled ? {
    base_url              = module.web_tools_runtime[0].base_url
    chromium_dns_name     = module.web_tools_runtime[0].chromium_dns_name
    chromium_service_name = module.web_tools_runtime[0].chromium_service_name
    cluster_arn           = module.web_tools_runtime[0].cluster_arn
    dynamodb_table_name   = module.web_tools_runtime[0].dynamodb_table_name
    service_name          = module.web_tools_runtime[0].service_name
    task_definition_arn   = module.web_tools_runtime[0].task_definition_arn
  } : null
}

output "app_runtime" {
  description = "Agent-built apps cluster connection metadata and its client security groups, or null when apps are disabled."
  value       = one(module.app_runtime)
}

output "sandbox_lambda_microvm_artifact_bucket_name" {
  value = try(module.sandbox_runtime[0].lambda_microvm_artifact_bucket_name, null)
}

output "sandbox_lambda_microvm_build_role_arn" {
  value = try(module.sandbox_runtime[0].lambda_microvm_build_role_arn, null)
}

output "sandbox_lambda_microvm_log_group_name" {
  value = try(module.sandbox_runtime[0].lambda_microvm_log_group_name, null)
}

output "sandbox_lambda_microvm_runtime_configuration" {
  value = try(module.sandbox_runtime[0].lambda_microvm_runtime_configuration, null)
}

output "sandbox_lambda_microvm_runtime_policy_arn" {
  value = try(module.sandbox_runtime[0].lambda_microvm_runtime_policy_arn, null)
}

output "semantic_event_bus_arn" {
  value = try(module.platform_events[0].event_bus_arn, null)
}

output "semantic_event_bus_name" {
  value = try(module.platform_events[0].event_bus_name, null)
}

output "semantic_event_dispatcher_failure_bucket_arn" {
  value = try(module.platform_events[0].event_dispatcher_failure_bucket_arn, null)
}

output "semantic_event_dispatcher_function_arn" {
  value = try(module.platform_events[0].event_dispatcher_function_arn, null)
}

output "agent_email" {
  value = {
    api_endpoint                      = try(module.platform_api[0].api_endpoint, null)
    api_function_arn                  = module.agent_email.api_function_arn
    api_invoke_arn                    = module.agent_email.api_invoke_arn
    bucket_name                       = module.agent_email.bucket_name
    configuration_set_name            = module.agent_email.configuration_set_name
    dns_records                       = module.agent_email.dns_records
    events_topic_arn                  = module.agent_email.events_topic_arn
    inbound_processing_ready          = module.agent_email.inbound_processing_ready
    inbound_function_arn              = module.agent_email.inbound_function_arn
    maintenance_trigger_configured    = module.agent_email.maintenance_trigger_configured
    managed_worker_function_arns      = module.agent_email.managed_worker_function_arns
    queue_arns                        = module.agent_email.queue_arns
    queue_urls                        = module.agent_email.queue_urls
    regional_event_topic_kms_key_arns = module.agent_email.regional_event_topic_kms_key_arns
    worker_policy_arns                = module.agent_email.worker_policy_arns
  }
}

output "event_analytics_athena" {
  value = local.event_analytics_managed ? module.event_analytics[0].athena_query : null
}

output "event_analytics_athena_catalog_name" {
  value = try(module.event_analytics[0].athena_catalog_name, null)
}

output "event_analytics_athena_database_name" {
  value = try(module.event_analytics[0].athena_database_name, null)
}

output "event_analytics_athena_workgroup_name" {
  value = try(module.event_analytics[0].athena_workgroup_name, null)
}

output "event_analytics_firehose_delivery_stream_arn" {
  value = try(module.event_analytics[0].firehose_delivery_stream_arn, null)
}

output "event_analytics_operator_query_policy_arn" {
  value = try(module.event_analytics[0].operator_query_policy_arn, null)
}

output "event_analytics_projector_function_arn" {
  value = try(module.event_analytics[0].projector_function_arn, null)
}

output "event_analytics_s3_table_bucket_arn" {
  value = module.platform_data.semantic_event_table_bucket_arn
}

output "agent_runtime_worker" {
  description = "Agent worker ECS service identifiers the deploy tool verifies after each rollout."
  value = try({
    cluster_arn         = module.agent_runtime[0].worker_cluster_arn
    service_name        = module.agent_runtime[0].worker_service_name
    task_definition_arn = module.agent_runtime[0].worker_task_definition_arn
  }, null)
}

output "stream_gateway_base_url" {
  description = "Public stream gateway origin, or null when the gateway is disabled."
  value       = try(module.stream_gateway[0].base_url, null)
}

output "agent_runtime_api_endpoint" {
  value = try(module.agent_runtime[0].api_endpoint, null)
}

output "agent_runtime_scheduler_group_name" {
  value = try(module.agent_runtime[0].scheduler_group_name, null)
}

output "agent_observability" {
  value = try({
    athena_workgroup_name               = module.agent_observability[0].athena_workgroup_name
    backup_bucket                       = module.agent_observability[0].backup_bucket_name
    clickhouse_rebuild_query_id         = module.agent_observability[0].clickhouse_rebuild_query_id
    erasure_athena_workgroup_name       = module.agent_observability[0].erasure_athena_workgroup_name
    erasure_function_name               = module.agent_observability[0].erasure_function_name
    fact_stream_arn                     = module.agent_observability[0].fact_stream_arn
    projector_checkpoint_table          = module.agent_observability[0].projector_checkpoint_table_name
    projector_event_source_mapping_uuid = module.agent_observability[0].projector_event_source_mapping_uuid
    failure_queue_urls                  = module.agent_observability[0].failure_queue_urls
    firehose_stream_names               = module.agent_observability[0].firehose_stream_names
    quarantine_bucket                   = module.agent_observability[0].quarantine_bucket_name
    rebuild_query_id                    = module.agent_observability[0].rebuild_query_id
    reconciliation_query_id             = module.agent_observability[0].reconciliation_query_id
    watermark_query_id                  = module.agent_observability[0].watermark_query_id
  }, null)
}

output "agent_observability_hot" {
  value = try({
    api_base_url              = module.agent_observability_hot[0].api_base_url
    backup_bucket             = module.agent_observability_hot[0].backup_bucket_name
    checkpoint_table          = module.agent_observability_hot[0].checkpoint_table_name
    clickhouse_host           = module.agent_observability_hot[0].clickhouse_host
    cluster_arn               = module.agent_observability_hot[0].cluster_arn
    data_volume_id            = module.agent_observability_hot[0].data_volume_id
    instance_id               = module.agent_observability_hot[0].instance_id
    runtime_secret_arn        = module.agent_observability_hot[0].runtime_secret_arn
    service_secret_arn        = module.agent_observability_hot[0].service_secret_arn
    service_secret_version_id = module.agent_observability_hot[0].service_secret_version_id
    service_name              = module.agent_observability_hot[0].service_name
  }, null)
}

output "agent_run_queue_arn" {
  value = try(module.agent_runtime[0].queue_arn, null)
}

output "agent_run_queue_url" {
  value = try(module.agent_runtime[0].queue_url, null)
}

output "usage_materializer_function_arn" {
  value = try(module.agent_runtime[0].usage_materializer_function_arn, null)
}

output "ops_alerts_topic_arn" {
  value = module.ops_alerts.topic_arn
}

output "ops_alerts_slack_bot_token_parameter_name" {
  value = module.ops_alerts.slack_bot_token_parameter_name
}
