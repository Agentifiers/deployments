variable "identity_table_arn" {
  description = "ARN of the platform identity DynamoDB table, where directory provisioning creates principals."
  type        = string
}

variable "identity_table_name" {
  description = "Name of the platform identity DynamoDB table."
  type        = string
}

variable "identity_email_kms_key_arn" {
  description = "Platform identity email envelope KMS key ARN. Empty disables organization invitation email."
  type        = string
  default     = ""
}

variable "identity_email_table_arn" {
  description = "ARN of the identity email outbox DynamoDB table; required with identity_email_kms_key_arn."
  type        = string
  default     = ""
}

variable "identity_email_table_name" {
  description = "Name of the identity email outbox DynamoDB table; required with identity_email_kms_key_arn."
  type        = string
  default     = ""
}

variable "identity_federation" {
  description = "Platform identity federation key (kms_key_arn) the API seals customer identity-provider client secrets with; null when platform identity is disabled."
  type = object({
    kms_key_arn = string
  })
  default = null
}
