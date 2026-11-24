variable "domain_name" {
  description = "OpenSearch domain name; also the security group name prefix."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,27}$", var.domain_name))
    error_message = "domain_name must be 3-28 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "environment" {
  description = "Deployment environment name used for tags."
  type        = string
}

variable "instance_count" {
  description = "OpenSearch data node count."
  type        = number
  validation {
    condition = (
      var.instance_count >= 1 &&
      floor(var.instance_count) == var.instance_count &&
      (var.instance_count == 1 || var.instance_count % 2 == 0 || var.instance_count % 3 == 0)
    )
    error_message = "OpenSearch instance count must be 1 or a positive multiple of 2 or 3 so nodes can be distributed evenly across zones."
  }
}

variable "instance_type" {
  description = "OpenSearch data node type."
  type        = string
}

variable "network" {
  description = "VPC and private subnets for the domain's endpoint, one subnet per zone, or null for a public IAM-authorized endpoint."
  type = object({
    private_subnet_ids = list(string)
    vpc_id             = string
  })
  default = null
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "volume_size" {
  description = "gp3 volume size in GiB per data node."
  type        = number
}
