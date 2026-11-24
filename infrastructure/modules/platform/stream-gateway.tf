module "stream_gateway" {
  count  = var.agent_runtime_enabled ? 1 : 0
  source = "../stream-gateway"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                                 = module.ops_alerts.topic_arn
  allowed_origins                                 = local.stream_gateway_allowed_origins
  compact_task_sizing_enabled                     = var.operations.compact_sizing
  container_insights_enabled                      = var.operations.enhanced_monitoring
  deletion_protection_enabled                     = var.stream_gateway_deletion_protection_enabled
  domain_name                                     = lower(trimspace(var.stream_gateway_domain_name))
  durable_streams_auth_secret_arn                 = module.durable_streams[0].auth_token_secret_arn
  durable_streams_base_url                        = module.durable_streams[0].base_url
  durable_streams_load_balancer_security_group_id = module.model_runtime[0].internal_load_balancer.security_group_id
  environment                                     = var.environment
  fargate_spot_enabled                            = var.operations.fargate_spot
  high_availability_enabled                       = var.operations.high_availability
  image                                           = var.stream_gateway_image
  log_retention_in_days                           = var.operations.log_retention_days
  permissions_boundary_arn                        = var.iam_permissions_boundary_arn
  private_subnet_ids                              = module.platform_network[0].private_subnet_ids
  public_subnet_ids                               = module.platform_network[0].public_subnet_ids
  route53_zone_id                                 = var.platform_api_route53_zone_id
  # Without dedicated public load balancers, CloudFront reaches the gateway through a VPC origin
  # on the shared internal ALB.
  shared_load_balancer = var.operations.dedicated_public_load_balancers ? null : {
    arn               = module.model_runtime[0].internal_load_balancer.arn
    arn_suffix        = module.model_runtime[0].internal_load_balancer.arn_suffix
    dns_name          = module.model_runtime[0].internal_load_balancer.dns_name
    security_group_id = module.model_runtime[0].internal_load_balancer.security_group_id
  }
  stream_session_secret_arn = module.agent_runtime[0].stream_session_secret_arn
  tags                      = var.tags
  vpc_id                    = module.platform_network[0].vpc_id
}

locals {
  # The console reads thread streams from the browser, so the gateway admits every https origin the
  # console signs in from: the application origin and each web redirect URI's origin, including a
  # dev install's https://*.<domain> wildcard.
  stream_gateway_allowed_origins = var.console_enabled ? distinct(concat(
    [var.platform_identity_application_origin],
    [for uri in var.platform_identity_web_redirect_uris : regex("^https://[^/]+", uri) if startswith(uri, "https://")],
  )) : []
}
