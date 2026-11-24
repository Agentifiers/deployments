variable "enable_platform_events" {
  description = "Whether to create the semantic event dispatcher infrastructure."
  type        = bool
  default     = false
}

variable "event_dispatcher_artifact_bucket" {
  description = "S3 bucket containing the event dispatcher Lambda artifact."
  type        = string
  default     = null
}

variable "event_dispatcher_artifact_key" {
  description = "S3 object key for the event dispatcher Lambda artifact."
  type        = string
  default     = null
}

variable "event_dispatcher_artifact_version" {
  description = "Immutable S3 object version for the event dispatcher Lambda artifact."
  type        = string
  default     = null
}

variable "channel_provider_runtime_enabled" {
  description = "Whether to create channel ingress, delivery, provider-tool, and credential-vault runtime infrastructure."
  type        = bool
  default     = false
}

variable "channel_provider_domain_name" {
  description = "Public hostname for channel ingress, the credential API, and OAuth callbacks, in the platform API Route 53 zone. Empty serves them on the API Gateway execute-api endpoint."
  type        = string
  default     = ""
}

variable "channel_provider_artifact_bucket" {
  description = "S3 bucket containing the channel/provider Lambda artifact."
  type        = string
  default     = ""
}

variable "channel_provider_artifact_key" {
  description = "S3 key containing the channel/provider Lambda artifact."
  type        = string
  default     = ""
}

variable "channel_provider_artifact_version" {
  description = "Immutable S3 object version for the channel/provider Lambda artifact."
  type        = string
  default     = ""
}

variable "channel_provider_rcs_role_arns" {
  description = "Vertical-owned AWS End User Messaging RCS delivery role ARNs allowed in this deployment."
  type        = set(string)
  default     = []
}

variable "channel_provider_jwt_audience" {
  description = "JWT audiences accepted by the channel/provider credential API unless runtime_jwt_from_platform_identity applies."
  type        = list(string)
  default     = []
}

variable "channel_provider_jwt_issuer" {
  description = "HTTPS JWT issuer for the channel/provider credential API unless runtime_jwt_from_platform_identity applies."
  type        = string
  default     = ""
}

variable "channel_provider_oauth_apps_json" {
  description = "Secret-free OAuth provider endpoint configuration shared by the API and channel/provider runtime."
  type        = string
  default     = "{}"
}

variable "channel_provider_oauth_return_origins" {
  description = "Allowlist of exact HTTPS origins (for example https://app.example.com) the provider OAuth callback may redirect the browser to via the authorization returnTo URL. Empty disables returnTo redirects."
  type        = list(string)
  default     = []
}

variable "agent_email_activate_receipt_rule_set" {
  description = "Explicitly activate the module-owned SES receipt rule set."
  type        = bool
  default     = false
}

variable "agent_email_domain" {
  description = "Hosted agent email domain."
  type        = string
}

variable "agent_email_disable_account_suppression" {
  description = "Disable SES account suppression only in a dedicated agent-email sending account."
  type        = bool
  default     = false
}

variable "agent_email_enable_runtime" {
  description = "Explicitly enable the managed agent-email API and workers."
  type        = bool
  default     = false
}

variable "agent_email_enable_catch_all_receiving" {
  description = "Authorize catch-all receipt-rule activation only in a dedicated agent-email account and region."
  type        = bool
  default     = false
}

variable "agent_email_artifact_bucket" {
  description = "Optional S3 bucket containing the bundled agent-email API and inbound Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_email_artifact_key" {
  description = "Optional S3 key containing the bundled agent-email Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_email_artifact_version" {
  description = "Optional immutable S3 object version for the bundled agent-email Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_email_lambda_function_arns" {
  description = "Optional deployed send, events, stream-dispatcher, maintenance, or legacy inbound worker Lambda ARNs."
  type        = map(string)
  default     = {}
}

variable "agent_email_lambda_role_names" {
  description = "Optional execution role names corresponding to agent_email_lambda_function_arns."
  type        = map(string)
  default     = {}
}

variable "agent_email_manage_dns" {
  description = "Whether to create the agent email Route 53 DNS records."
  type        = bool
  default     = false
}

variable "agent_email_regional_event_topic_kms_key_arns" {
  description = "Pre-provisioned KMS key ARNs for secondary-region agent email event topics."
  type        = map(string)
  default     = {}
}

variable "agent_email_route53_zone_id" {
  description = "Route 53 hosted zone ID for the agent email domain, used only when agent_email_manage_dns is true."
  type        = string
  default     = ""
}
