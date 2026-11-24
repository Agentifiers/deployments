locals {
  event_analytics_managed               = contains(["decommissioning", "running", "stopped"], var.event_analytics_lifecycle)
  event_analytics_projector_enabled     = contains(["running", "stopped"], var.event_analytics_lifecycle)
  event_analytics_decommissioning       = var.event_analytics_lifecycle == "decommissioning"
  event_analytics_created_marker        = "/event-analytics/created"
  event_analytics_decommissioned_marker = "/event-analytics/decommissioned"
  event_analytics_destroyed_marker      = "/event-analytics/destroyed"
}

module "event_analytics" {
  count  = local.event_analytics_managed ? 1 : 0
  source = "../event-analytics"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                     = module.ops_alerts.topic_arn
  destructive_cleanup_enabled         = local.event_analytics_decommissioning
  environment                         = var.environment
  event_bus_name                      = module.platform_events[0].event_bus_name
  extra_event_sources                 = var.event_analytics_extra_sources
  failure_retention_in_days           = var.operations.failure_retention_days
  log_retention_in_days               = var.operations.log_retention_days
  permissions_boundary_arn            = var.iam_permissions_boundary_arn
  projector_enabled                   = local.event_analytics_projector_enabled
  projector_artifact_bucket           = var.event_analytics_projector_artifact_bucket
  projector_artifact_key              = var.event_analytics_projector_artifact_key
  projector_artifact_version          = var.event_analytics_projector_artifact_version
  query_result_retention_in_days      = var.operations.query_result_retention_days
  s3_table_arn                        = module.platform_data.semantic_event_table_arn
  s3_table_bucket_arn                 = module.platform_data.semantic_event_table_bucket_arn
  s3_table_bucket_name                = module.platform_data.semantic_event_table_bucket_name
  s3_table_name                       = module.platform_data.semantic_event_table_name
  s3_table_namespace                  = module.platform_data.semantic_event_table_namespace
  s3tables_catalog_arn                = module.platform_data.s3tables_catalog_arn
  s3tables_catalog_name               = module.platform_data.s3tables_catalog_name
  storage_deletion_protection_enabled = var.operations.deletion_protection
  tags                                = var.tags
}

resource "aws_ssm_parameter" "event_analytics_created_marker" {
  count = var.lifecycle_markers_enabled && var.event_analytics_lifecycle != "absent" ? 1 : 0

  name  = local.event_analytics_created_marker
  type  = "String"
  value = "created"
  tags  = var.tags

  depends_on = [module.event_analytics]
}

resource "aws_ssm_parameter" "event_analytics_decommissioned_marker" {
  count = var.lifecycle_markers_enabled && contains(["decommissioning", "destroyed"], var.event_analytics_lifecycle) ? 1 : 0

  name  = local.event_analytics_decommissioned_marker
  type  = "String"
  value = "decommissioned"
  tags  = var.tags

  depends_on = [module.event_analytics]
}

resource "aws_ssm_parameter" "event_analytics_destroyed_marker" {
  count = var.lifecycle_markers_enabled && var.event_analytics_lifecycle == "destroyed" ? 1 : 0

  name  = local.event_analytics_destroyed_marker
  type  = "String"
  value = "destroyed"
  tags  = var.tags

  depends_on = [module.event_analytics]
}

data "aws_ssm_parameters_by_path" "event_analytics_lifecycle" {
  count = var.lifecycle_markers_enabled ? 1 : 0

  path            = "/event-analytics"
  recursive       = false
  with_decryption = false
}

resource "terraform_data" "event_analytics_lifecycle_guard" {
  count = var.lifecycle_markers_enabled ? 1 : 0

  input = var.event_analytics_lifecycle

  lifecycle {
    precondition {
      condition = (
        var.event_analytics_lifecycle != "absent" ||
        !contains(data.aws_ssm_parameters_by_path.event_analytics_lifecycle[0].names, local.event_analytics_created_marker)
      )
      error_message = "event_analytics_lifecycle=absent is only valid before the analytics stack has ever been created."
    }

    precondition {
      condition = (
        var.event_analytics_lifecycle != "destroyed" ||
        contains(data.aws_ssm_parameters_by_path.event_analytics_lifecycle[0].names, local.event_analytics_decommissioned_marker)
      )
      error_message = "Apply event_analytics_lifecycle=decommissioning successfully before setting event_analytics_lifecycle=destroyed."
    }

    precondition {
      condition = (
        !contains(data.aws_ssm_parameters_by_path.event_analytics_lifecycle[0].names, local.event_analytics_destroyed_marker) ||
        var.event_analytics_lifecycle == "destroyed"
      )
      error_message = "event_analytics_lifecycle=destroyed is terminal because recreating the stack would not restore its deleted event history."
    }
  }
}
