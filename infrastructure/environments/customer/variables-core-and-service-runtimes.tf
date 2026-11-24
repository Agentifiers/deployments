variable "aws_region" {
  description = "AWS region of the install; the deploy tool sets it from the deployment target."
  type        = string
}

variable "aws_account_id" {
  description = "Dedicated AWS account of the install; the deploy tool sets it from the deployment target."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "agent_email_route53_zone_id" {
  description = "Route 53 hosted zone that contains agent_email_domain, for its SES verification, DKIM, MAIL FROM, and MX records. Required while agent_email_manage_dns is true."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_email_manage_dns || can(regex("^Z[A-Z0-9]+$", trimspace(var.agent_email_route53_zone_id)))
    error_message = "agent_email_route53_zone_id must be a Route 53 hosted zone ID when agent_email_manage_dns is true."
  }
}

variable "agent_email_activate_receipt_rule_set" {
  description = "Activate the stack's SES receipt rule set, the account's single active rule set in this region, so mail to agent_email_domain reaches agent inboxes."
  type        = bool
  default     = true

  validation {
    condition = !var.agent_email_activate_receipt_rule_set || (
      var.agent_email_enable_catch_all_receiving && var.agent_email_enable_runtime && var.agent_runtime_enabled
    )
    error_message = "agent_email_activate_receipt_rule_set requires agent_email_enable_catch_all_receiving, agent_email_enable_runtime, and agent_runtime_enabled."
  }
}

variable "agent_email_domain" {
  description = "Hosted agent email domain. The stack always creates its SES domain identity, so it must be a domain the install owns."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.agent_email_domain))
    error_message = "agent_email_domain must be a lowercase DNS name."
  }
}

variable "agent_email_disable_account_suppression" {
  description = "Clear the SES account-level suppression list reasons, so one tenant's bounces never suppress another tenant's hosted domain. The agent email send workers require it."
  type        = bool
  default     = true
}

variable "agent_email_enable_runtime" {
  description = "Run the agent email API and workers. Requires the public API."
  type        = bool
  default     = true

  validation {
    condition     = !var.agent_email_enable_runtime || (var.platform_api_enabled && var.agent_email_disable_account_suppression)
    error_message = "agent_email_enable_runtime requires platform_api_enabled and agent_email_disable_account_suppression."
  }
}

variable "agent_email_enable_catch_all_receiving" {
  description = "Receive mail for every address at agent_email_domain. The install's account and region must serve no other SES receiving."
  type        = bool
  default     = true
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
  description = "Create the agent email Route 53 records in agent_email_route53_zone_id. Set false to publish them yourself."
  type        = bool
  default     = true
}

variable "agent_email_regional_event_topic_kms_key_arns" {
  description = "Pre-provisioned KMS key ARNs for secondary-region agent email event topics."
  type        = map(string)
  default     = {}
}

variable "bifrost_desired_count" {
  description = "Model gateway task count. The deploy tool seeds the runtime parameters before it applies the full root, so a first deploy can start at one or more."
  type        = number
  default     = 1
}

variable "bifrost_image" {
  description = "Digest-pinned ARM64 Bifrost image built from infrastructure/images/bifrost and supplied by the deploy tool."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.bifrost_image))
    error_message = "Set bifrost_image to a sha256-pinned image."
  }
}

variable "model_gateway_image" {
  description = "Digest-pinned ARM64 image built from apps/model-gateway; the production root always runs the model runtime."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.model_gateway_image))
    error_message = "Set model_gateway_image to a sha256-pinned image."
  }
}

variable "model_gateway_previous_signing_key_arns" {
  description = "Retired model gateway token signing KMS key ARNs still trusted during a key rotation."
  type        = list(string)
  default     = []
}

variable "durable_streams_desired_count" {
  description = "Durable Streams task count, zero or one."
  type        = number
  default     = 1
}

variable "durable_streams_deletion_protection_enabled" {
  description = "Whether the production Durable Streams load balancer has deletion protection enabled. Disable this in a separate apply before removing the runtime."
  type        = bool
  default     = true
}

variable "durable_streams_enabled" {
  description = "Whether to create the private Durable Streams runtime. Production keeps this enabled so its persistent filesystem remains managed; scale desired_count to zero to stop service tasks."
  type        = bool
  default     = true

  validation {
    condition     = var.durable_streams_enabled
    error_message = "Production Durable Streams cannot be disabled because removing the module would remove its persistent EFS configuration; set durable_streams_desired_count to zero instead."
  }
}

variable "durable_streams_image" {
  description = "Digest-pinned image built from apps/durable-streams/Dockerfile."
  type        = string
  default     = ""

  validation {
    condition     = !var.durable_streams_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.durable_streams_image))
    error_message = "Set durable_streams_image to a sha256-pinned image when Durable Streams is enabled."
  }
}

variable "stream_gateway_deletion_protection_enabled" {
  description = "Whether the production stream gateway load balancer has deletion protection enabled. Disable this in a separate apply before removing the gateway."
  type        = bool
  default     = true
}

variable "stream_gateway_domain_name" {
  description = "Public hostname for the stream gateway."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.agent_runtime_enabled ||
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", lower(trimspace(var.stream_gateway_domain_name))))
    )
    error_message = "stream_gateway_domain_name must be a valid DNS hostname when agent_runtime_enabled is true."
  }
}

variable "stream_gateway_image" {
  description = "Digest-pinned image built from apps/stream-gateway."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_runtime_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.stream_gateway_image))
    error_message = "Set stream_gateway_image to a sha256-pinned image when agent_runtime_enabled is true."
  }
}

variable "channel_provider_runtime_enabled" {
  description = "Whether to create channel ingress, delivery, provider-tool, and credential-vault runtime infrastructure."
  type        = bool
  default     = true

  validation {
    condition     = !var.channel_provider_runtime_enabled || var.enable_platform_events
    error_message = "enable_platform_events must be true when channel_provider_runtime_enabled is true."
  }

}

variable "channel_provider_domain_name" {
  description = "Public hostname for channel ingress, the credential API, and OAuth callbacks, in platform_api_route53_zone_id. Empty serves them on the API Gateway execute-api endpoint."
  type        = string
  default     = ""
}

variable "channel_provider_artifact_bucket" {
  description = "S3 bucket containing the channel/provider Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.channel_provider_runtime_enabled || try(trimspace(var.channel_provider_artifact_bucket) != "", false)
    error_message = "channel_provider_artifact_bucket is required when channel_provider_runtime_enabled is true."
  }
}

variable "channel_provider_artifact_key" {
  description = "S3 key containing the channel/provider Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.channel_provider_runtime_enabled || try(trimspace(var.channel_provider_artifact_key) != "", false)
    error_message = "channel_provider_artifact_key is required when channel_provider_runtime_enabled is true."
  }
}

variable "channel_provider_artifact_version" {
  description = "Immutable S3 object version for the channel/provider Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.channel_provider_runtime_enabled ||
      (
        trimspace(var.channel_provider_artifact_version) != "" &&
        lower(trimspace(var.channel_provider_artifact_version)) != "null"
      )
    )
    error_message = "A non-null channel_provider_artifact_version is required when channel_provider_runtime_enabled is true."
  }
}

variable "channel_provider_rcs_role_arns" {
  description = "Vertical-owned AWS End User Messaging RCS delivery role ARNs allowed in production."
  type        = set(string)
  default     = []

  validation {
    condition = length(var.channel_provider_rcs_role_arns) <= 50 && alltrue([
      for arn in var.channel_provider_rcs_role_arns : can(regex("^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "channel_provider_rcs_role_arns must contain at most 50 concrete IAM role ARNs without wildcards."
  }
}

variable "channel_provider_oauth_apps_json" {
  description = "Secret-free OAuth provider endpoint configuration; {} configures none. Provider request header values must be credential:<field> references resolved from provider-application vault records."
  type        = string
  default     = "{}"

  validation {
    condition     = can(keys(jsondecode(var.channel_provider_oauth_apps_json)))
    error_message = "channel_provider_oauth_apps_json must be a JSON object."
  }
}

variable "channel_provider_oauth_return_origins" {
  description = "Allowlist of exact HTTPS origins (for example https://app.example.com) the provider OAuth callback may redirect the browser to via the authorization returnTo URL. Empty disables returnTo redirects."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.channel_provider_oauth_return_origins : can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", origin))
    ])
    error_message = "channel_provider_oauth_return_origins entries must be exact HTTPS origins (https://host[:port]) without path, query, fragment, trailing slash, or userinfo."
  }
}

variable "model_runtime_availability_zones" {
  description = "Two availability zones for the model runtime VPC."
  type        = list(string)

  validation {
    condition     = length(toset(var.model_runtime_availability_zones)) == 2
    error_message = "Set two distinct model_runtime_availability_zones."
  }
}

variable "tags" {
  description = "Additional tags applied to every install resource."
  type        = map(string)
  default     = {}
}

variable "platform_identity_enabled" {
  description = "Whether to deploy the platform identity service. The deploy tool always sets it to true; the console, the public API's sign-in, and the CLI device flow need it."
  type        = bool
  default     = true
}
variable "platform_identity_application_origin" {
  description = "Exact HTTPS origin of the console, such as https://app.example.com. The web sign-in redirect is <origin>/auth/callback."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+(:[0-9]{1,5})?$", var.platform_identity_application_origin))
    error_message = "platform_identity_application_origin must be an exact lowercase HTTPS origin without a path or trailing slash."
  }
}
variable "platform_identity_api_artifact_bucket" {
  type    = string
  default = ""
}
variable "platform_identity_api_artifact_key" {
  type    = string
  default = ""
}
variable "platform_identity_api_artifact_version" {
  type    = string
  default = ""
}
variable "platform_identity_certificate_arn" {
  type    = string
  default = ""
}
variable "platform_identity_cli_redirect_uris" {
  type    = list(string)
  default = ["http://127.0.0.1/callback", "http://[::1]/callback"]
}
variable "platform_identity_domain_name" {
  description = "Hostname of the identity provider, such as auth.example.com. Its HTTPS URL is the token issuer."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.platform_identity_domain_name))
    error_message = "platform_identity_domain_name must be a lowercase DNS hostname."
  }
}
variable "platform_identity_email_artifact_bucket" {
  type    = string
  default = ""
}
variable "platform_identity_email_artifact_key" {
  type    = string
  default = ""
}
variable "platform_identity_email_artifact_version" {
  type    = string
  default = ""
}
variable "platform_identity_email_sender" {
  description = "Mailbox that sends sign-in email, such as auth@example.com. Its domain needs SES production access."
  type        = string
}
variable "platform_identity_publish_domain" {
  type    = bool
  default = false
}
variable "platform_identity_registration_enabled" {
  type    = bool
  default = false
}
variable "platform_identity_route53_zone_id" {
  type    = string
  default = ""
}
