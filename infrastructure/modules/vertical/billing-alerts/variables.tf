variable "account_id" {
  description = "AWS account that owns the billing alerts."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "alert_email" {
  description = "Mailbox that receives budget and cost anomaly alerts."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", trimspace(var.alert_email)))
    error_message = "alert_email must be a valid mailbox address."
  }
}

variable "anomaly_threshold_usd" {
  description = "Minimum unexpected cost impact in USD that triggers an anomaly alert."
  type        = number

  validation {
    condition     = var.anomaly_threshold_usd > 0
    error_message = "anomaly_threshold_usd must be greater than zero."
  }
}

variable "daily_budget_usd" {
  description = "Daily account spend guardrail in USD."
  type        = number

  validation {
    condition     = var.daily_budget_usd > 0
    error_message = "daily_budget_usd must be greater than zero."
  }
}

variable "environment" {
  description = "Deployment environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "kms_key" {
  description = "Existing customer-managed KMS key that encrypts the anomaly alert topic. Its policy must let costalerts.amazonaws.com call kms:Decrypt and kms:GenerateDataKey* for the topic. Null creates a dedicated alert key. The key is wrapped in an object so whether to create one is known at plan time even before the ARN exists."
  type = object({
    arn = string
  })
  default = null

  validation {
    condition     = var.kms_key == null || can(regex("^arn:aws[a-z-]*:kms:[^:]+:[0-9]{12}:key/", var.kms_key.arn))
    error_message = "kms_key.arn must be a KMS key ARN."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly account spend guardrail in USD."
  type        = number

  validation {
    condition     = var.monthly_budget_usd >= var.daily_budget_usd
    error_message = "monthly_budget_usd must be greater than or equal to daily_budget_usd."
  }
}

variable "name_prefix" {
  description = "Stable prefix for billing alert resource names, for example `<product>-<environment>-billing`."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", var.name_prefix))
    error_message = "name_prefix must be lowercase kebab-case."
  }
}

variable "product_name" {
  description = "Product tag applied to billing alert resources."
  type        = string

  validation {
    condition     = trimspace(var.product_name) != ""
    error_message = "product_name must not be empty."
  }
}

variable "tags" {
  description = "Additional tags applied to billing alert resources."
  type        = map(string)
  default     = {}
}
