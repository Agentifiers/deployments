locals {
  openai_tailnet_relay_enabled = var.model_runtime_enabled && var.model_runtime_openai_tailnet_upstream != null
  model_runtime_openai_base_url = local.openai_tailnet_relay_enabled ? (
    "http://${module.openai_tailnet_relay[0].private_ip}:${var.model_runtime_openai_tailnet_upstream.port}"
  ) : ""
}

# Its own Tailscale client keeps tailnet traffic off the NAT path, which rejects 100.64.0.0/10.
module "openai_tailnet_relay" {
  count  = local.openai_tailnet_relay_enabled ? 1 : 0
  source = "../tailnet-relay"

  client_security_group_id = module.model_runtime[0].gateway_security_group_id
  environment              = var.environment
  name                     = "models-openai-relay"
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  subnet_id                = module.platform_network[0].private_subnet_ids[0]
  tags                     = var.tags
  tailnet_hostname         = "deployments-ai-${var.environment}-openai-relay"
  upstream                 = var.model_runtime_openai_tailnet_upstream
  vpc_id                   = module.platform_network[0].vpc_id
}
