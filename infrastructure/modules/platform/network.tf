locals {
  platform_network_enabled = (
    var.model_runtime_enabled ||
    var.memory_runtime_enabled ||
    var.web_tools_runtime_enabled ||
    var.durable_streams_enabled ||
    var.agent_observability_hot_enabled ||
    var.apps_enabled
  )

  # Runtimes take an object or null rather than a VPC ID so whether they attach is known at
  # plan, before a first apply creates the VPC.
  private_network = local.platform_network_enabled ? {
    private_subnet_ids = module.platform_network[0].private_subnet_ids
    vpc_id             = module.platform_network[0].vpc_id
  } : null
}

module "platform_network" {
  count  = local.platform_network_enabled ? 1 : 0
  source = "../network"

  name                = "network"
  availability_zones  = var.availability_zones
  cidr_block          = var.network_cidr_block
  nat_mode            = var.network_nat_mode
  nat_instance_ami_id = var.network_nat_instance_ami_id
  nat_instance_type   = var.network_nat_instance_type
  single_nat_gateway  = var.network_single_nat_gateway
  tags                = var.tags
}
