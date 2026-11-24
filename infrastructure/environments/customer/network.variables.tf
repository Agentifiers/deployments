variable "network_nat_mode" {
  description = "Private subnet egress: gateway runs managed NAT gateways; instance runs one fck-nat EC2 instance for the whole VPC that also rejects forwarding to private and reserved IPv4 ranges, which the in-stack web tools require. Null uses instance while web_tools_runtime_enabled is true and gateway otherwise."
  type        = string
  default     = null

  validation {
    condition     = var.network_nat_mode == null || contains(["gateway", "instance"], coalesce(var.network_nat_mode, "gateway"))
    error_message = "network_nat_mode must be gateway, instance, or null."
  }
}

variable "network_nat_instance_ami_id" {
  description = "ARM64 fck-nat AMI for the NAT instance. Empty pins the newest fck-nat AL2023 ARM64 AMI that the fck-nat publisher (568608671756) offers in the region at the first apply; set an AMI ID to move to another one."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.network_nat_instance_ami_id == "" || can(regex("^ami-[0-9a-f]+$", var.network_nat_instance_ami_id))
    error_message = "network_nat_instance_ami_id must be empty or an AMI ID."
  }
}

variable "network_nat_instance_type" {
  description = "ARM64 instance type of the NAT instance. Every private-subnet egress byte, including Bedrock and ECR traffic, crosses it."
  type        = string
  default     = "t4g.small"
  nullable    = false
}

variable "network_single_nat_gateway" {
  description = "In gateway mode, whether every private subnet shares one NAT gateway instead of one per availability zone. Saves one NAT gateway and loses egress when its zone fails."
  type        = bool
  default     = false
  nullable    = false
}

locals {
  network_nat_mode = coalesce(var.network_nat_mode, var.web_tools_runtime_enabled ? "instance" : "gateway")
}

data "aws_ami" "fck_nat" {
  count = local.network_nat_mode == "instance" && var.network_nat_instance_ami_id == "" ? 1 : 0

  most_recent = true
  owners      = ["568608671756"]

  filter {
    name   = "name"
    values = ["fck-nat-al2023-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Keeps the AMI resolved at the first apply, so a new fck-nat release never replaces the NAT
# instance and drops the VPC's egress on a routine deploy.
resource "terraform_data" "nat_instance_ami" {
  count = local.network_nat_mode == "instance" && var.network_nat_instance_ami_id == "" ? 1 : 0

  input = data.aws_ami.fck_nat[0].id

  lifecycle {
    ignore_changes = [input]
  }
}
