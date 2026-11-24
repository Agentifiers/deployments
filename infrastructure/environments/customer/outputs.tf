output "data_kms_key_arn" {
  value = module.platform.data_kms_key_arn
}

output "artifact_bucket_arn" {
  value = module.platform.artifact_bucket_arn
}

output "artifact_bucket_name" {
  value = module.platform.artifact_bucket_name
}

output "platform_api_endpoint" {
  value = module.platform.platform_api_endpoint
}

output "platform_api_function_arn" {
  value = module.platform.platform_api_function_arn
}

output "platform_identity_function_arns" {
  value = module.platform.platform_identity_function_arns
}

output "platform_identity_bootstrap" {
  value = module.platform.platform_identity_bootstrap
}

output "dynamodb_table_arns" {
  value = module.platform.dynamodb_table_arns
}

output "dynamodb_table_names" {
  value = module.platform.dynamodb_table_names
}

output "dynamodb_table_stream_arns" {
  value = module.platform.dynamodb_table_stream_arns
}

output "channel_provider_api_endpoint" {
  value = module.platform.channel_provider_api_endpoint
}

output "channel_provider_delivery_role_arn" {
  description = "Platform principal that vertical-owned RCS delivery roles must trust."
  value       = module.platform.channel_provider_delivery_role_arn
}

output "channel_provider_credential_writer_policy_arn" {
  value = module.platform.channel_provider_credential_writer_policy_arn
}

output "channel_provider_credential_vault_role_arns" {
  value = module.platform.channel_provider_credential_vault_role_arns
}

output "channel_provider_queue_arns" {
  value = module.platform.channel_provider_queue_arns
}

output "memory_api_endpoint" {
  value = module.platform.memory_api_endpoint
}

output "memory_queue_arns" {
  value = module.platform.memory_queue_arns
}

output "search_placement_functions" {
  value = module.platform.search_placement_functions
}

output "durable_streams_auth_token_secret_arn" {
  value = module.platform.durable_streams_auth_token_secret_arn
}

output "durable_streams_base_url" {
  value = module.platform.durable_streams_base_url
}

output "durable_streams_cluster_arn" {
  value = module.platform.durable_streams_cluster_arn
}

output "durable_streams_service_name" {
  value = module.platform.durable_streams_service_name
}

output "model_runtime_bedrock_region" {
  value = module.platform.model_runtime_bedrock_region
}

output "model_gateway_base_url" {
  value = module.platform.model_gateway_base_url
}

output "model_runtime_cluster_arn" {
  value = module.platform.model_runtime_cluster_arn
}

output "model_runtime_hosted_providers" {
  value = module.platform.model_runtime_hosted_providers
}

output "model_runtime_service_name" {
  value = module.platform.model_runtime_service_name
}

output "model_runtime_secret_arns" {
  value = module.platform.model_runtime_secret_arns
}

output "model_runtime_vpc_id" {
  value = module.platform.model_runtime_vpc_id
}

output "sandbox_lambda_microvm_artifact_bucket_name" {
  value = module.platform.sandbox_lambda_microvm_artifact_bucket_name
}

output "sandbox_lambda_microvm_build_role_arn" {
  value = module.platform.sandbox_lambda_microvm_build_role_arn
}

output "sandbox_lambda_microvm_log_group_name" {
  value = module.platform.sandbox_lambda_microvm_log_group_name
}

output "sandbox_lambda_microvm_runtime_configuration" {
  value = module.platform.sandbox_lambda_microvm_runtime_configuration
}

output "sandbox_lambda_microvm_runtime_policy_arn" {
  value = module.platform.sandbox_lambda_microvm_runtime_policy_arn
}

output "semantic_event_bus_arn" {
  value = module.platform.semantic_event_bus_arn
}

output "semantic_event_bus_name" {
  value = module.platform.semantic_event_bus_name
}

output "semantic_event_dispatcher_failure_bucket_arn" {
  value = module.platform.semantic_event_dispatcher_failure_bucket_arn
}

output "semantic_event_dispatcher_function_arn" {
  value = module.platform.semantic_event_dispatcher_function_arn
}

output "agent_email" {
  value = module.platform.agent_email
}

output "event_analytics_athena" {
  value = module.platform.event_analytics_athena
}

output "event_analytics_athena_catalog_name" {
  value = module.platform.event_analytics_athena_catalog_name
}

output "event_analytics_athena_database_name" {
  value = module.platform.event_analytics_athena_database_name
}

output "event_analytics_athena_workgroup_name" {
  value = module.platform.event_analytics_athena_workgroup_name
}

output "event_analytics_firehose_delivery_stream_arn" {
  value = module.platform.event_analytics_firehose_delivery_stream_arn
}

output "event_analytics_operator_query_policy_arn" {
  value = module.platform.event_analytics_operator_query_policy_arn
}

output "event_analytics_projector_function_arn" {
  value = module.platform.event_analytics_projector_function_arn
}

output "event_analytics_s3_table_bucket_arn" {
  value = module.platform.event_analytics_s3_table_bucket_arn
}

output "agent_runtime_worker" {
  description = "Agent worker ECS service identifiers the deploy tool verifies after each rollout."
  value       = module.platform.agent_runtime_worker
}

output "agent_runtime_api_endpoint" {
  value = module.platform.agent_runtime_api_endpoint
}

output "agent_runtime_scheduler_group_name" {
  value = module.platform.agent_runtime_scheduler_group_name
}

output "agent_observability" {
  value = module.platform.agent_observability
}

output "agent_observability_hot" {
  value = module.platform.agent_observability_hot
}

output "agent_run_queue_arn" {
  value = module.platform.agent_run_queue_arn
}

output "agent_run_queue_url" {
  value = module.platform.agent_run_queue_url
}

output "usage_materializer_function_arn" {
  value = module.platform.usage_materializer_function_arn
}

output "stream_gateway_base_url" {
  value = module.platform.stream_gateway_base_url
}

output "platform_identity_issuer" {
  value = module.platform.platform_identity_issuer
}

output "console_url" {
  value = module.platform.console_url
}

output "console_assets_bucket" {
  value = module.platform.console_assets_bucket
}

output "console_distribution_domain_name" {
  value = module.platform.console_distribution_domain_name
}

output "ops_alerts_topic_arn" {
  value = module.platform.ops_alerts_topic_arn
}

output "ops_alerts_slack_bot_token_parameter_name" {
  value = module.platform.ops_alerts_slack_bot_token_parameter_name
}

output "web_tools_runtime" {
  value = module.platform.web_tools_runtime
}

output "app_runtime" {
  value = module.platform.app_runtime
}
