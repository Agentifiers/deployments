module "platform_events" {
  count  = var.enable_platform_events ? 1 : 0
  source = "../platform-events"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn             = module.ops_alerts.topic_arn
  deletion_protection_enabled = var.operations.deletion_protection
  dispatcher_artifact_bucket  = var.event_dispatcher_artifact_bucket
  dispatcher_artifact_key     = var.event_dispatcher_artifact_key
  dispatcher_artifact_version = var.event_dispatcher_artifact_version
  environment                 = var.environment
  events_stream_arn           = module.platform_data.table_stream_arns["events"]
  failure_retention_in_days   = var.operations.failure_retention_days
  log_retention_in_days       = var.operations.log_retention_days
  permissions_boundary_arn    = var.iam_permissions_boundary_arn
  tags                        = var.tags
}

module "channel_provider_runtime" {
  count  = var.channel_provider_runtime_enabled ? 1 : 0
  source = "../channel-provider-runtime"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                        = module.ops_alerts.topic_arn
  artifact_bucket                        = var.channel_provider_artifact_bucket
  artifact_key                           = var.channel_provider_artifact_key
  artifact_version                       = var.channel_provider_artifact_version
  control_table_arn                      = module.platform_data.table_arns["control"]
  control_table_name                     = module.platform_data.table_names["control"]
  credential_vault_reader_principal_arns = var.agent_runtime_enabled ? [module.inbound_runtime[0].channel_ingress_flush_role_arn] : []
  durable_streams_auth_secret_arn        = var.agent_runtime_enabled ? module.durable_streams[0].auth_token_secret_arn : ""
  durable_streams_base_url               = var.agent_runtime_enabled ? module.durable_streams[0].base_url : ""
  data_kms_key_arn                       = module.platform_data.kms_key_arn
  domain_name                            = var.channel_provider_domain_name
  environment                            = var.environment
  event_bus_arn                          = module.platform_events[0].event_bus_arn
  event_bus_name                         = module.platform_events[0].event_bus_name
  events_table_arn                       = module.platform_data.table_arns["events"]
  events_table_name                      = module.platform_data.table_names["events"]
  execution_table_arn                    = module.platform_data.table_arns["execution"]
  execution_table_name                   = module.platform_data.table_names["execution"]
  jwt_audience                           = local.channel_provider_jwt_audiences
  jwt_issuer                             = local.channel_provider_jwt_issuer
  log_retention_in_days                  = var.operations.log_retention_days
  network                                = var.agent_runtime_enabled ? local.private_network : null
  oauth_apps_json                        = var.channel_provider_oauth_apps_json
  oauth_return_origins                   = local.oauth_return_origins
  permissions_boundary_arn               = var.iam_permissions_boundary_arn
  rcs_provider_role_arns                 = var.channel_provider_rcs_role_arns
  route53_zone_id                        = trimspace(var.channel_provider_domain_name) == "" ? "" : var.platform_api_route53_zone_id
  tags                                   = var.tags
}

module "inbound_runtime" {
  count  = var.agent_runtime_enabled && var.channel_provider_runtime_enabled ? 1 : 0
  source = "../inbound-runtime"

  agent_run_queue_arn                 = module.agent_runtime[0].queue_arn
  agent_run_queue_url                 = module.agent_runtime[0].queue_url
  alarms_enabled                      = module.ops_alerts.connected
  alarm_topic_arn                     = module.ops_alerts.topic_arn
  artifact_bucket                     = var.channel_provider_artifact_bucket
  artifact_key                        = var.channel_provider_artifact_key
  artifact_version                    = var.channel_provider_artifact_version
  channel_ingress_queue_arn           = module.channel_provider_runtime[0].queue_arns["channel-ingress"]
  control_table_arn                   = module.platform_data.table_arns["control"]
  control_table_name                  = module.platform_data.table_names["control"]
  credential_vault_reader_role_arn    = module.channel_provider_runtime[0].credential_vault_role_arns["reader"]
  data_kms_key_arn                    = module.platform_data.kms_key_arn
  document_extraction_function        = { arn = module.document_extraction.function_arn, function_name = module.document_extraction.function_name }
  end_user_subject_key_arn            = module.agent_runtime[0].end_user_subject_key_arn
  environment                         = var.environment
  events_table_arn                    = module.platform_data.table_arns["events"]
  events_table_name                   = module.platform_data.table_names["events"]
  execution_table_arn                 = module.platform_data.table_arns["execution"]
  execution_table_name                = module.platform_data.table_names["execution"]
  ingress_attachment_capture_role_arn = module.platform_data.ingress_attachment_capture_role_arn
  log_retention_in_days               = var.operations.log_retention_days
  permissions_boundary_arn            = var.iam_permissions_boundary_arn
  platform_artifact_bucket_name       = module.platform_data.artifact_bucket_name
  tags                                = var.tags
  usage_table_arn                     = module.platform_data.table_arns["usage"]
  usage_table_name                    = module.platform_data.table_names["usage"]
}

module "agent_email" {
  depends_on = [module.agent_runtime, module.platform_identity]
  source     = "../agent-email"

  account_id                             = var.aws_account_id
  activate_receipt_rule_set              = var.agent_email_activate_receipt_rule_set
  agent_run_queue_arn                    = try(module.agent_runtime[0].queue_arn, "")
  agent_run_queue_url                    = try(module.agent_runtime[0].queue_url, "")
  alarms_enabled                         = module.ops_alerts.connected
  alarm_topic_arn                        = module.ops_alerts.topic_arn
  api_jwt_audience                       = var.platform_api_enabled ? local.api_jwt_audience : ""
  api_jwt_claim_profile                  = local.api_jwt_claim_profile
  api_jwt_issuer                         = var.platform_api_enabled ? local.api_jwt_issuer : ""
  artifact_bucket_name                   = module.platform_data.artifact_bucket_name
  domain                                 = var.agent_email_domain
  disable_account_suppression            = var.agent_email_disable_account_suppression
  data_kms_key_arn                       = module.platform_data.kms_key_arn
  default_model_spend_ceiling_usd_micros = var.default_model_spend_ceiling_usd_micros
  document_extraction_function           = { arn = module.document_extraction.function_arn, function_name = module.document_extraction.function_name }
  dynamodb_table_arns                    = local.shared_runtime_table_arns
  deletion_protection_enabled            = var.operations.deletion_protection
  enable_catch_all_receiving             = var.agent_email_enable_catch_all_receiving
  enable_inbound_runtime                 = var.agent_runtime_enabled
  enable_runtime                         = var.agent_email_enable_runtime
  environment                            = var.environment
  end_user_subject_key_arn               = try(module.agent_runtime[0].end_user_subject_key_arn, "")
  events_stream_arn                      = module.platform_data.table_stream_arns["events"]
  ingress_attachment_capture_role_arn    = module.platform_data.ingress_attachment_capture_role_arn
  lambda_function_arns                   = var.agent_email_lambda_function_arns
  lambda_role_names                      = var.agent_email_lambda_role_names
  legacy_bucket_arns                     = local.legacy_agent_email_bucket_arns
  legacy_bucket_names                    = local.legacy_agent_email_bucket_names
  log_retention_in_days                  = var.operations.log_retention_days
  manage_dns                             = var.agent_email_manage_dns
  permissions_boundary_arn               = var.iam_permissions_boundary_arn
  region                                 = var.aws_region
  regional_event_topic_kms_key_arns      = var.agent_email_regional_event_topic_kms_key_arns
  route53_zone_id                        = var.agent_email_route53_zone_id
  request_admission_table_arn            = module.platform_data.request_admission_table_arn
  request_admission_table_name           = module.platform_data.request_admission_table_name
  runtime_artifact_bucket                = var.platform_api_enabled ? var.agent_email_artifact_bucket : ""
  runtime_artifact_key                   = var.platform_api_enabled ? var.agent_email_artifact_key : ""
  runtime_artifact_version               = var.platform_api_enabled ? var.agent_email_artifact_version : ""
  tags                                   = var.tags
  tenant_limit_defaults_json             = jsonencode(var.operations.tenant_limit_defaults)
}
