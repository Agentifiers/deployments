variable "system_service_principals" {
  description = "Machine services, by name, whose role's assumed-role sessions may call /v1/system/services/* with SigV4. A service's holds and entitlement grant belong to source service:<name>. grants: organization-read, organization-holds, organization-entitlements. Empty adds no route."
  type = map(object({
    role_arn = string
    grants   = set(string)
  }))
  default  = {}
  nullable = false

  validation {
    condition = alltrue([
      for name in keys(var.system_service_principals) : can(regex("^[a-z0-9][a-z0-9-]{0,62}$", name))
    ])
    error_message = "Each system_service_principals name must be 1 to 63 lowercase letters, digits, or hyphens, not starting with a hyphen."
  }

  validation {
    condition = alltrue([
      for principal in values(var.system_service_principals) :
      can(regex("^arn:aws[a-z-]*:iam::${var.account_id}:role/([^/[:space:]]+/)*[\\w+=,.@-]{1,64}$", principal.role_arn))
    ])
    error_message = "Each system_service_principals role_arn must be an IAM role ARN in this install's account. A role in another account can never be admitted."
  }

  validation {
    condition = alltrue([
      for principal in values(var.system_service_principals) :
      length(setsubtract(principal.grants, ["organization-read", "organization-holds", "organization-entitlements"])) == 0
    ])
    error_message = "system_service_principals grants must be organization-read, organization-holds, or organization-entitlements."
  }

  validation {
    condition = length([
      for principal in values(var.system_service_principals) : principal
      if contains(principal.grants, "organization-entitlements")
    ]) <= 1
    error_message = "At most one system_service_principals entry may hold organization-entitlements, because an organization carries a single service grant."
  }

  validation {
    condition = length(distinct([
      for principal in values(var.system_service_principals) :
      lower(try(regex("[^/]+$", principal.role_arn), principal.role_arn))
    ])) == length(var.system_service_principals)
    error_message = "Each system_service_principals entry needs its own role. An assumed-role session names only the role, so two services cannot share one."
  }
}

variable "default_model_spend_ceiling_usd_micros" {
  description = "Monthly operator-funded model spend, in USD micros, that an organization may use when no grant sets its own ceiling. Spend on the organization's own provider keys never counts. Null leaves it unlimited."
  type        = number
  default     = null

  validation {
    condition = var.default_model_spend_ceiling_usd_micros == null || try(
      floor(var.default_model_spend_ceiling_usd_micros) == var.default_model_spend_ceiling_usd_micros &&
      var.default_model_spend_ceiling_usd_micros >= 0 &&
      var.default_model_spend_ceiling_usd_micros <= 9007199254740991,
      false,
    )
    error_message = "default_model_spend_ceiling_usd_micros must be null or a whole number of USD micros from 0 to 9007199254740991."
  }
}
