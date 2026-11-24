locals {
  legacy_artifact_bucket_name     = "deployments-ai-platform-${var.environment}-${var.aws_account_id}-artifacts"
  legacy_agent_email_bucket_name  = "platform-${var.environment}-agent-email-${var.aws_account_id}"
  legacy_governance_bucket_name   = "deployments-ai-platform-${var.environment}-${var.aws_account_id}-governance"
  legacy_artifact_bucket_arns     = var.legacy_account_local_buckets_enabled ? ["arn:aws:s3:::${local.legacy_artifact_bucket_name}"] : []
  legacy_artifact_bucket_names    = var.legacy_account_local_buckets_enabled ? [local.legacy_artifact_bucket_name] : []
  legacy_agent_email_bucket_arns  = var.legacy_account_local_buckets_enabled ? ["arn:aws:s3:::${local.legacy_agent_email_bucket_name}"] : []
  legacy_agent_email_bucket_names = var.legacy_account_local_buckets_enabled ? [local.legacy_agent_email_bucket_name] : []
  legacy_governance_bucket_arns   = var.legacy_account_local_buckets_enabled ? ["arn:aws:s3:::${local.legacy_governance_bucket_name}"] : []
  legacy_governance_bucket_names  = var.legacy_account_local_buckets_enabled ? [local.legacy_governance_bucket_name] : []
  shared_runtime_table_names = {
    for name, table_name in module.platform_data.table_names : name => table_name
    if contains(["control", "events", "execution", "usage"], name)
  }
  shared_runtime_table_arns = {
    for name, table_arn in module.platform_data.table_arns : name => table_arn
    if contains(["control", "events", "execution", "usage"], name)
  }
}

module "platform_data" {
  source = "../platform-data"

  agent_observability_history_enabled        = var.agent_observability_history_enabled
  agent_observability_noncurrent_file_days   = var.agent_observability_noncurrent_file_days
  agent_observability_snapshot_max_age_hours = var.agent_observability_snapshot_max_age_hours
  agent_observability_unreferenced_file_days = var.agent_observability_unreferenced_file_days
  alarms_enabled                             = module.ops_alerts.connected
  alarm_topic_arn                            = module.ops_alerts.topic_arn
  deletion_protection_enabled                = var.operations.deletion_protection
  environment                                = var.environment
  ingress_attachment_capture_principal_arns = concat(
    var.agent_runtime_enabled && var.channel_provider_runtime_enabled ? [module.inbound_runtime[0].channel_ingress_flush_role_arn] : [],
    module.agent_email.inbound_role_arns,
  )
  kms_deletion_window_in_days = var.operations.kms_deletion_window_days
  permissions_boundary_arn    = var.iam_permissions_boundary_arn
  sns_service_publishers = {
    SesPublishesAgentEmailTopics = {
      service     = "ses.amazonaws.com"
      topic_names = ["agent-email-inbound", "agent-email-events"]
    }
    CostAnomalyAlertsPublish = {
      service     = "costalerts.amazonaws.com"
      topic_names = ["platform-${var.environment}-billing-immediate-anomalies"]
    }
    CloudWatchPublishesOpsAlerts = {
      service     = "cloudwatch.amazonaws.com"
      topic_names = ["ops-alerts"]
    }
  }
  tags = var.tags
}
