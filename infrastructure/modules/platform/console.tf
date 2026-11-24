module "console" {
  count  = var.console_enabled ? 1 : 0
  source = "../console"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  additional_environment      = var.console_additional_environment
  additional_policy_json      = var.console_additional_policy_json
  alarms_enabled              = module.ops_alerts.connected
  alarm_topic_arn             = module.ops_alerts.topic_arn
  application_origin          = var.platform_identity_application_origin
  artifact_bucket             = var.console_artifact_bucket
  artifact_key                = var.console_artifact_key
  artifact_version            = var.console_artifact_version
  certificate_arn             = var.console_certificate_arn
  data_kms_key_arn            = module.platform_data.kms_key_arn
  deletion_protection_enabled = var.operations.deletion_protection
  detailed_metrics_enabled    = var.operations.enhanced_monitoring
  docs_origin                 = var.console_docs_origin
  environment                 = var.environment
  identity_issuer             = local.platform_identity_issuer
  identity_table_arn          = module.platform_data.table_arns["identity"]
  identity_table_name         = module.platform_data.table_names["identity"]
  log_retention_in_days       = var.operations.log_retention_days
  oauth_callback_origin       = one(module.channel_provider_runtime[*].oauth_public_origin)
  permissions_boundary_arn    = var.iam_permissions_boundary_arn
  platform_api_url            = try(module.platform_api[0].api_endpoint, "")
  route53_zone_id             = var.console_route53_zone_id
  stream_gateway_url          = try(module.stream_gateway[0].base_url, "")
  tags                        = var.tags
  web_client_secret_arn       = try(module.platform_identity[0].client_bootstrap.web_client_secret_arn, "")
  web_redirect_uris           = var.platform_identity_web_redirect_uris
}

output "console_url" {
  description = "Public HTTPS origin serving the management console, or null when the console is disabled."
  value       = try(module.console[0].url, null)
}

output "console_assets_bucket" {
  description = "S3 bucket holding the console static assets, or null when the console is disabled."
  value       = try(module.console[0].assets_bucket_name, null)
}

output "console_distribution_domain_name" {
  description = "CloudFront domain name serving the console, or null when the console is disabled."
  value       = try(module.console[0].distribution_domain_name, null)
}
