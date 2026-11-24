variable "name" {
  type = string
}

variable "cidr_block" {
  type    = string
  default = "10.42.0.0/16"
}

variable "availability_zones" {
  type = list(string)
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "nat_mode" {
  description = "Private-subnet IPv4 egress implementation. Use an EC2 NAT instance for cost-sensitive development and managed gateways for production."
  type        = string
  default     = "gateway"

  validation {
    condition     = contains(["gateway", "instance"], var.nat_mode)
    error_message = "nat_mode must be gateway or instance."
  }
}

variable "nat_instance_type" {
  description = "ARM64 EC2 instance type used when nat_mode is instance."
  type        = string
  default     = "t4g.nano"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.nat_instance_type))
    error_message = "nat_instance_type must be a valid EC2 instance type."
  }
}

variable "nat_instance_ami_id" {
  description = "Immutable regional ARM64 fck-nat AMI used when nat_mode is instance."
  type        = string
  default     = ""

  validation {
    condition = (
      var.nat_mode != "instance" ||
      can(regex("^ami-[0-9a-f]+$", var.nat_instance_ami_id))
    )
    error_message = "nat_instance_ami_id must be a concrete AMI ID when nat_mode is instance."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
