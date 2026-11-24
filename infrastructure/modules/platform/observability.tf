module "agent_observability" {
  count  = var.agent_observability_history_enabled ? 1 : 0
  source = "../agent-observability"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                = module.ops_alerts.topic_arn
  clickhouse_backup_expiry_days  = try(module.agent_observability_hot[0].backup_expiry_days, { ebs_snapshot = 0, native_backup = 0 })
  control_table_arn              = module.platform_data.table_arns["control"]
  control_table_name             = module.platform_data.table_names["control"]
  deletion_protection_enabled    = var.operations.deletion_protection
  destructive_cleanup_enabled    = var.agent_observability_destructive_cleanup_enabled
  environment                    = var.environment
  execution_table_stream_arn     = module.platform_data.table_stream_arns["execution"]
  fact_stream_retention_hours    = var.agent_observability_fact_stream_retention_hours
  history_retention_in_days      = var.operations.observability_retention_days
  hot_plane_base_url             = try(module.agent_observability_hot[0].api_base_url, "")
  hot_plane_secret_arn           = try(module.agent_observability_hot[0].service_secret_arn, "")
  lambda_artifact_bucket         = var.agent_runtime_artifact_bucket
  lambda_artifact_key            = var.agent_runtime_artifact_key
  lambda_artifact_version        = var.agent_runtime_artifact_version
  log_retention_in_days          = var.operations.log_retention_days
  network                        = local.private_network
  permissions_boundary_arn       = var.iam_permissions_boundary_arn
  physical_removal               = module.platform_data.agent_observability_physical_removal
  point_in_time_recovery_enabled = var.operations.deletion_protection
  s3_table_arns                  = module.platform_data.agent_observability_table_arns
  s3_table_bucket_arn            = module.platform_data.agent_observability_table_bucket_arn
  s3_table_bucket_name           = module.platform_data.agent_observability_table_bucket_name
  s3_table_names                 = module.platform_data.agent_observability_table_names
  s3_table_namespace             = module.platform_data.agent_observability_table_namespace
  s3tables_catalog_arn           = module.platform_data.s3tables_catalog_arn
  s3tables_catalog_name          = module.platform_data.s3tables_catalog_name
  tags                           = var.tags
  usage_table_stream_arn         = module.platform_data.table_stream_arns["usage"]
}

module "agent_observability_hot" {
  count  = var.agent_observability_hot_enabled ? 1 : 0
  source = "../observability-clickhouse"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn             = module.ops_alerts.topic_arn
  ami_id                      = var.agent_observability_clickhouse_ami_id
  backup_retention_in_days    = coalesce(var.agent_observability_clickhouse_backup_retention_days, min(var.operations.backup_retention_days, 7))
  container_insights_enabled  = var.operations.enhanced_monitoring
  control_table_arn           = module.platform_data.table_arns["control"]
  control_table_name          = module.platform_data.table_names["control"]
  data_volume_size_gib        = var.agent_observability_clickhouse_data_volume_size_gib
  deletion_protection_enabled = var.operations.deletion_protection
  desired_count               = 1
  detailed_monitoring_enabled = var.operations.enhanced_monitoring
  ecs_exec_enabled            = var.operations.operator_shell_access
  environment                 = var.environment
  fact_stream_arn             = module.agent_observability[0].fact_stream_arn
  fargate_spot_enabled        = var.operations.fargate_spot
  hot_plane_image             = var.agent_observability_hot_image
  instance_type               = var.agent_observability_clickhouse_instance_type
  log_retention_in_days       = var.operations.log_retention_days
  permissions_boundary_arn    = var.iam_permissions_boundary_arn
  private_subnet_ids          = module.platform_network[0].private_subnet_ids
  quarantine_bucket_arn       = module.agent_observability[0].quarantine_bucket_arn
  quarantine_bucket_name      = module.agent_observability[0].quarantine_bucket_name
  root_volume_size_gib        = var.agent_observability_clickhouse_root_volume_size_gib
  server_memory_bytes         = var.agent_observability_clickhouse_server_memory_bytes
  tags                        = var.tags
  task_size                   = var.agent_observability_hot_task_size
  vpc_cidr                    = var.network_cidr_block
  vpc_id                      = module.platform_network[0].vpc_id
}
