variable "billing_alert_email" {
  description = "Mailbox that receives the install account's billing alerts."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.billing_alert_email))
    error_message = "billing_alert_email must be an email address."
  }
}

variable "billing_anomaly_threshold_usd" {
  description = "Minimum unexpected cost impact that triggers an anomaly alert."
  type        = number
  default     = 100
}

variable "billing_daily_budget_usd" {
  description = "Daily account spend guardrail."
  type        = number
  default     = 100
}

variable "billing_monthly_budget_usd" {
  description = "Monthly account spend guardrail."
  type        = number
  default     = 350
}

module "billing_alerts" {
  source = "../../modules/vertical/billing-alerts"

  account_id            = var.aws_account_id
  alert_email           = var.billing_alert_email
  anomaly_threshold_usd = var.billing_anomaly_threshold_usd
  daily_budget_usd      = var.billing_daily_budget_usd
  environment           = var.environment_name
  kms_key               = { arn = module.platform.data_kms_key_arn }
  monthly_budget_usd    = var.billing_monthly_budget_usd
  name_prefix           = "platform-${var.environment_name}-billing"
  product_name          = "deployments-ai-platform"
  tags                  = var.tags
}
