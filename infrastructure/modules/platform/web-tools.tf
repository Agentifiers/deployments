resource "aws_security_group" "web_tools_client" {
  count = var.web_tools_runtime_enabled ? 1 : 0

  name_prefix = "web-tools-client-"
  description = "Hosted agent worker identity for private Firecrawl access"
  vpc_id      = module.platform_network[0].vpc_id

  tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Name        = "web-tools-client"
    Product     = "deployments-ai-platform"
  })
}

module "web_tools_runtime" {
  count  = var.web_tools_runtime_enabled ? 1 : 0
  source = "../web-tools-runtime"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                 = module.ops_alerts.topic_arn
  chromium_cpu                    = var.web_tools_chromium_cpu
  chromium_desired_count          = var.web_tools_chromium_desired_count
  chromium_max_concurrent_pages   = var.web_tools_chromium_max_concurrent_pages
  chromium_memory                 = var.web_tools_chromium_memory
  compact_task_sizing_enabled     = var.operations.compact_sizing
  deletion_protection_enabled     = var.operations.deletion_protection
  desired_count                   = var.web_tools_desired_count
  domain_name                     = var.web_tools_domain_name
  ecs_cluster_arn                 = module.model_runtime[0].ecs_cluster_arn
  environment                     = var.environment
  fargate_spot_enabled            = var.operations.fargate_spot
  firecrawl_embedding_model_name  = var.web_tools_firecrawl_embedding_model_name
  firecrawl_image                 = var.web_tools_firecrawl_image
  firecrawl_model_name            = var.web_tools_firecrawl_model_name
  firecrawl_table                 = var.web_tools_firecrawl_table
  load_balancer_arn               = module.model_runtime[0].internal_load_balancer.arn
  load_balancer_dns_name          = module.model_runtime[0].internal_load_balancer.dns_name
  load_balancer_security_group_id = module.model_runtime[0].internal_load_balancer.security_group_id
  load_balancer_zone_id           = module.model_runtime[0].internal_load_balancer.zone_id
  log_retention_in_days           = var.operations.service_log_retention_days
  model_gateway_base_url          = "${module.model_runtime[0].model_gateway_base_url}/v1"
  model_gateway_token_issuer      = module.agent_runtime[0].model_token_issuers["web-tools"]
  permissions_boundary_arn        = var.iam_permissions_boundary_arn
  point_in_time_recovery_enabled  = var.operations.deletion_protection
  private_subnet_ids              = module.platform_network[0].private_subnet_ids
  proxy_image                     = var.web_tools_proxy_image
  reserved_ipv4_egress_filtered   = module.platform_network[0].reserved_ipv4_egress_filtered
  route53_zone_id                 = var.web_tools_route53_zone_id
  secret_recovery_window_in_days  = var.operations.secret_recovery_window_days
  tags                            = var.tags
  vpc_id                          = module.platform_network[0].vpc_id
}
