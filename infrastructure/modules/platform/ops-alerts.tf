module "ops_alerts" {
  source = "../ops-alerts"

  alert_email               = var.operations.ops_alerts_email
  environment               = var.environment
  kms_key_arn               = module.platform_data.kms_key_arn
  log_retention_in_days     = var.operations.log_retention_days
  notifier_artifact_bucket  = var.ops_alerts_notifier_artifact_bucket
  notifier_artifact_key     = var.ops_alerts_notifier_artifact_key
  notifier_artifact_version = var.ops_alerts_notifier_artifact_version
  permissions_boundary_arn  = var.iam_permissions_boundary_arn
  slack_channel_id          = var.operations.ops_alerts_slack_channel_id
  tags                      = var.tags
}
