provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.default_tags
  }
}

provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.default_tags
  }
}

locals {
  default_tags = { Environment = var.environment_name }

  api_audience    = "https://${var.platform_api_domain_name}"
  identity_issuer = "https://${var.platform_identity_domain_name}"

  web_tools_domain_name     = coalesce(var.web_tools_domain_name, "web-tools.${var.platform_api_domain_name}")
  web_tools_route53_zone_id = coalesce(var.web_tools_route53_zone_id, var.platform_api_route53_zone_id)
}

module "platform" {
  source = "../../modules/platform"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = var.environment_name
  aws_account_id = var.aws_account_id
  aws_region     = var.aws_region
  tags           = var.tags
  operations     = var.operations

  deploying_role_name          = var.deploying_role_name
  iam_permissions_boundary_arn = var.iam_permissions_boundary_arn
  system_alarm_name_prefix     = var.system_alarm_name_prefix
  system_observer_role_arns    = var.system_observer_role_arns

  ops_alerts_notifier_artifact_bucket  = var.ops_alerts_notifier_artifact_bucket
  ops_alerts_notifier_artifact_key     = var.ops_alerts_notifier_artifact_key
  ops_alerts_notifier_artifact_version = var.ops_alerts_notifier_artifact_version

  availability_zones          = var.model_runtime_availability_zones
  network_cidr_block          = var.network_cidr_block
  network_nat_instance_ami_id = var.network_nat_instance_ami_id != "" ? var.network_nat_instance_ami_id : try(terraform_data.nat_instance_ami[0].output, "")
  network_nat_instance_type   = var.network_nat_instance_type
  network_nat_mode            = local.network_nat_mode
  network_single_nat_gateway  = var.network_single_nat_gateway

  model_runtime_hosted_providers           = var.model_runtime_hosted_providers
  model_gateway_service_fallback_model_ids = var.model_gateway_service_fallback_model_ids
  memory_runtime_embedding_model           = var.memory_runtime_embedding_model
  memory_runtime_rerank_model              = var.memory_runtime_rerank_model
  memory_runtime_flush_model               = var.memory_runtime_flush_model
  brain_runtime_answer_model               = var.brain_runtime_answer_model

  platform_identity_enabled                = var.platform_identity_enabled
  platform_identity_api_artifact_bucket    = var.platform_identity_api_artifact_bucket
  platform_identity_api_artifact_key       = var.platform_identity_api_artifact_key
  platform_identity_api_artifact_version   = var.platform_identity_api_artifact_version
  platform_identity_application_origin     = var.platform_identity_application_origin
  platform_identity_certificate_arn        = var.platform_identity_certificate_arn
  platform_identity_cli_redirect_uris      = var.platform_identity_cli_redirect_uris
  platform_identity_domain_name            = var.platform_identity_domain_name
  platform_identity_email_artifact_bucket  = var.platform_identity_email_artifact_bucket
  platform_identity_email_artifact_key     = var.platform_identity_email_artifact_key
  platform_identity_email_artifact_version = var.platform_identity_email_artifact_version
  platform_identity_email_sender           = var.platform_identity_email_sender
  platform_identity_publish_domain         = var.platform_identity_publish_domain
  platform_identity_registration_enabled   = var.platform_identity_registration_enabled
  platform_identity_resource_audience      = local.api_audience
  platform_identity_route53_zone_id        = var.platform_identity_route53_zone_id
  platform_identity_web_redirect_uris      = ["${var.platform_identity_application_origin}/auth/callback"]
  runtime_jwt_from_platform_identity       = true

  platform_api_enabled                        = var.platform_api_enabled
  platform_api_artifact_bucket                = var.platform_api_artifact_bucket
  platform_api_artifact_key                   = var.platform_api_artifact_key
  platform_api_artifact_version               = var.platform_api_artifact_version
  platform_api_certificate_arn                = var.platform_api_certificate_arn
  platform_api_device_authorization_client_id = var.platform_api_device_authorization_client_id
  platform_api_device_authorization_issuer    = var.platform_api_device_authorization_issuer
  platform_api_domain_name                    = var.platform_api_domain_name
  platform_api_jwt_audience                   = local.api_audience
  platform_api_jwt_issuer                     = local.identity_issuer
  platform_api_route53_zone_id                = var.platform_api_route53_zone_id

  console_enabled          = var.console_enabled
  console_artifact_bucket  = var.console_artifact_bucket
  console_artifact_key     = var.console_artifact_key
  console_artifact_version = var.console_artifact_version
  console_certificate_arn  = var.console_certificate_arn
  console_route53_zone_id  = var.console_route53_zone_id

  apps_enabled                   = var.apps_enabled
  apps_domain                    = var.apps_domain
  apps_route53_zone_id           = var.apps_route53_zone_id
  app_gateway_image              = var.app_gateway_image
  apps_database_artifact_bucket  = var.apps_database_artifact_bucket
  apps_database_artifact_key     = var.apps_database_artifact_key
  apps_database_artifact_version = var.apps_database_artifact_version
  app_domains_artifact_bucket    = var.app_domains_artifact_bucket
  app_domains_artifact_key       = var.app_domains_artifact_key
  app_domains_artifact_version   = var.app_domains_artifact_version

  document_extraction_artifact_bucket  = var.document_extraction_artifact_bucket
  document_extraction_artifact_key     = var.document_extraction_artifact_key
  document_extraction_artifact_version = var.document_extraction_artifact_version
  document_extraction_ocr_enabled      = var.document_extraction_ocr_enabled

  agent_runtime_enabled                            = var.agent_runtime_enabled
  agent_runtime_artifact_bucket                    = var.agent_runtime_artifact_bucket
  agent_runtime_artifact_key                       = var.agent_runtime_artifact_key
  agent_runtime_artifact_version                   = var.agent_runtime_artifact_version
  agent_runtime_browser_allowed_origins            = var.agent_runtime_browser_allowed_origins
  agent_runtime_browser_any_public_origin          = var.agent_runtime_browser_any_public_origin
  agent_runtime_firecrawl_api_key_secret_arn       = var.agent_runtime_firecrawl_api_key_secret_arn
  agent_runtime_firecrawl_base_url                 = var.agent_runtime_firecrawl_base_url
  agent_runtime_firecrawl_job_ticket_secret_arn    = var.agent_runtime_firecrawl_job_ticket_secret_arn
  agent_runtime_legacy_webhook_signing_secret_arns = var.agent_runtime_legacy_webhook_signing_secret_arns
  agent_runtime_web_tools_enabled                  = var.agent_runtime_web_tools_enabled
  agent_worker_image                               = var.agent_worker_image

  bifrost_desired_count                   = var.bifrost_desired_count
  bifrost_image                           = var.bifrost_image
  model_gateway_image                     = var.model_gateway_image
  model_gateway_previous_signing_key_arns = var.model_gateway_previous_signing_key_arns

  durable_streams_enabled                     = var.durable_streams_enabled
  durable_streams_deletion_protection_enabled = var.durable_streams_deletion_protection_enabled
  durable_streams_desired_count               = var.durable_streams_desired_count
  durable_streams_image                       = var.durable_streams_image

  stream_gateway_deletion_protection_enabled = var.stream_gateway_deletion_protection_enabled
  stream_gateway_domain_name                 = var.stream_gateway_domain_name
  stream_gateway_image                       = var.stream_gateway_image

  sandbox_lambda_microvm_enabled  = var.sandbox_lambda_microvm_enabled
  lambda_microvm_image_capacity   = var.lambda_microvm_image_capacity
  lambda_microvm_image_identifier = var.lambda_microvm_image_identifier
  lambda_microvm_image_version    = var.lambda_microvm_image_version

  web_tools_runtime_enabled                = var.web_tools_runtime_enabled
  web_tools_chromium_desired_count         = var.web_tools_chromium_desired_count
  web_tools_desired_count                  = var.web_tools_desired_count
  web_tools_domain_name                    = local.web_tools_domain_name
  web_tools_firecrawl_embedding_model_name = var.web_tools_firecrawl_embedding_model_name
  web_tools_firecrawl_image                = var.web_tools_firecrawl_image
  web_tools_firecrawl_model_name           = var.web_tools_firecrawl_model_name
  web_tools_firecrawl_table                = var.web_tools_firecrawl_table
  web_tools_proxy_image                    = var.web_tools_proxy_image
  web_tools_route53_zone_id                = local.web_tools_route53_zone_id

  memory_runtime_enabled               = var.memory_runtime_enabled
  memory_runtime_artifact_bucket       = var.memory_runtime_artifact_bucket
  memory_runtime_artifact_key          = var.memory_runtime_artifact_key
  memory_runtime_artifact_version      = var.memory_runtime_artifact_version
  memory_runtime_jwt_audience          = [local.api_audience]
  memory_runtime_jwt_issuer            = local.identity_issuer
  memory_runtime_membership_keyring    = var.memory_runtime_membership_keyring
  memory_runtime_reconciliation_scopes = var.memory_runtime_reconciliation_scopes

  agent_observability_history_enabled          = var.agent_observability_history_enabled
  agent_observability_noncurrent_file_days     = var.agent_observability_noncurrent_file_days
  agent_observability_snapshot_max_age_hours   = var.agent_observability_snapshot_max_age_hours
  agent_observability_unreferenced_file_days   = var.agent_observability_unreferenced_file_days
  agent_observability_hot_enabled              = var.agent_observability_hot_enabled
  agent_observability_hot_image                = var.agent_observability_hot_image
  agent_observability_clickhouse_ami_id        = var.agent_observability_clickhouse_ami_id
  agent_observability_clickhouse_instance_type = var.agent_observability_clickhouse_instance_type

  agent_observability_clickhouse_backup_retention_days = var.agent_observability_clickhouse_backup_retention_days
  agent_observability_clickhouse_data_volume_size_gib  = var.agent_observability_clickhouse_data_volume_size_gib
  agent_observability_hot_task_size                    = var.agent_observability_hot_task_size

  enable_platform_events            = var.enable_platform_events
  event_dispatcher_artifact_bucket  = var.event_dispatcher_artifact_bucket
  event_dispatcher_artifact_key     = var.event_dispatcher_artifact_key
  event_dispatcher_artifact_version = var.event_dispatcher_artifact_version

  channel_provider_runtime_enabled      = var.channel_provider_runtime_enabled
  channel_provider_artifact_bucket      = var.channel_provider_artifact_bucket
  channel_provider_artifact_key         = var.channel_provider_artifact_key
  channel_provider_artifact_version     = var.channel_provider_artifact_version
  channel_provider_domain_name          = var.channel_provider_domain_name
  channel_provider_jwt_audience         = [local.api_audience]
  channel_provider_jwt_issuer           = local.identity_issuer
  channel_provider_oauth_apps_json      = var.channel_provider_oauth_apps_json
  channel_provider_oauth_return_origins = var.channel_provider_oauth_return_origins
  channel_provider_rcs_role_arns        = var.channel_provider_rcs_role_arns

  agent_email_activate_receipt_rule_set         = var.agent_email_activate_receipt_rule_set
  agent_email_artifact_bucket                   = var.agent_email_artifact_bucket
  agent_email_artifact_key                      = var.agent_email_artifact_key
  agent_email_artifact_version                  = var.agent_email_artifact_version
  agent_email_disable_account_suppression       = var.agent_email_disable_account_suppression
  agent_email_domain                            = var.agent_email_domain
  agent_email_enable_catch_all_receiving        = var.agent_email_enable_catch_all_receiving
  agent_email_enable_runtime                    = var.agent_email_enable_runtime
  agent_email_lambda_function_arns              = var.agent_email_lambda_function_arns
  agent_email_lambda_role_names                 = var.agent_email_lambda_role_names
  agent_email_manage_dns                        = var.agent_email_manage_dns
  agent_email_regional_event_topic_kms_key_arns = var.agent_email_regional_event_topic_kms_key_arns
  agent_email_route53_zone_id                   = var.agent_email_route53_zone_id

  event_analytics_lifecycle                  = var.event_analytics_lifecycle
  event_analytics_extra_sources              = var.event_analytics_extra_sources
  event_analytics_projector_artifact_bucket  = var.event_analytics_projector_artifact_bucket
  event_analytics_projector_artifact_key     = var.event_analytics_projector_artifact_key
  event_analytics_projector_artifact_version = var.event_analytics_projector_artifact_version
}
