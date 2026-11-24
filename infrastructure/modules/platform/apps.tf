module "app_runtime" {
  count  = var.apps_enabled ? 1 : 0
  source = "../app-runtime"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn             = module.ops_alerts.topic_arn
  compact_task_sizing_enabled = var.operations.compact_sizing
  container_insights_enabled  = var.operations.enhanced_monitoring
  control_table = {
    arn  = module.platform_data.table_arns["control"]
    name = module.platform_data.table_names["control"]
  }
  database_function_artifact = {
    bucket  = var.apps_database_artifact_bucket
    key     = var.apps_database_artifact_key
    version = var.apps_database_artifact_version
  }
  deletion_protection_enabled = var.operations.deletion_protection
  domain                      = var.apps_domain
  domain_reconciler_artifact = {
    bucket  = var.app_domains_artifact_bucket
    key     = var.app_domains_artifact_key
    version = var.app_domains_artifact_version
  }
  environment = var.environment
  events_table = {
    arn  = module.platform_data.table_arns["events"]
    name = module.platform_data.table_names["events"]
  }
  fargate_spot_enabled      = var.operations.fargate_spot
  gateway_image             = var.app_gateway_image
  high_availability_enabled = var.operations.high_availability
  identity_issuer           = local.platform_identity_issuer
  identity_table = {
    arn  = module.platform_data.table_arns["identity"]
    name = module.platform_data.table_names["identity"]
  }
  internal_load_balancer = {
    arn               = module.model_runtime[0].internal_load_balancer.arn
    dns_name          = module.model_runtime[0].internal_load_balancer.dns_name
    security_group_id = module.model_runtime[0].internal_load_balancer.security_group_id
  }
  log_retention_in_days    = var.operations.log_retention_days
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  private_subnet_ids       = module.platform_network[0].private_subnet_ids
  route53_zone_id          = var.apps_route53_zone_id
  tags                     = var.tags
  usage_table = {
    arn  = module.platform_data.table_arns["usage"]
    name = module.platform_data.table_names["usage"]
  }
  vpc_id = module.platform_network[0].vpc_id
}
