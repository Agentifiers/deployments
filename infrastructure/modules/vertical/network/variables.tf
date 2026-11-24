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

variable "nat_gateway_enabled" {
  description = "Whether private subnets receive NAT egress. Disable for idle dev foundations to avoid hourly NAT charges."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
