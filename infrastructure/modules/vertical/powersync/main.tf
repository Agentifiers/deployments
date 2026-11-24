module "service" {
  source = "../ecs-service"

  permissions_boundary_arn         = var.permissions_boundary_arn
  name                             = var.name
  cluster_arn                      = var.cluster_arn
  vpc_id                           = var.vpc_id
  subnet_ids                       = var.subnet_ids
  service_discovery_namespace_id   = var.service_discovery_namespace_id
  image                            = var.image
  architecture                     = "ARM64"
  cpu                              = var.cpu
  memory                           = var.memory
  desired_count                    = var.desired_count
  retain_task_definition_revisions = var.retain_task_definition_revisions
  # With one desired task, 101% still floors to one task and satisfies ECS
  # availability-zone rebalancing while preventing overlapping DB pools.
  deployment_maximum_percent         = 101
  deployment_minimum_healthy_percent = 0
  wait_for_steady_state              = var.wait_for_steady_state
  assign_public_ip                   = var.assign_public_ip
  command                            = ["start", "-r", "unified"]
  container_port                     = 8080
  environment = merge({
    NODE_OPTIONS                            = "--max-old-space-size-percentage=80"
    PS_DIRECT_DATABASE_PORT                 = tostring(var.direct_database_port)
    PS_PORT                                 = "8080"
    PS_STORAGE_TRANSACTION_CONNECTION_COUNT = tostring(var.storage_transaction_connections)
    POWERSYNC_CONFIG_GZIP_B64               = var.config_gzip_base64
    }, var.jwks_urls, var.config_version == "" ? {} : {
    PS_CONFIG_VERSION = var.config_version
  })
  secrets = {
    PS_DATABASE_URL         = var.source_database_direct_secret_arn
    PS_STORAGE_DATABASE_URL = var.storage_database_direct_secret_arn
  }
  health_check_command = [
    "CMD",
    "node",
    "--input-type=module",
    "--eval",
    "const response = await fetch('http://127.0.0.1:8080/probes/liveness'); if (!response.ok) process.exit(1);",
  ]
  health_check_path     = var.alb_health_check_path
  alb_listener_arn      = var.alb_listener_arn
  alb_security_group_id = var.alb_security_group_id
  route_prefix          = var.route_prefix
  route_priority        = var.route_priority
  tags                  = var.tags
}
