variable "system_observer_role_arns" {
  description = "IAM role ARNs in this account whose assumed-role sessions may call the read-only /v1/system/observer routes. Empty disables those routes."
  type        = list(string)
  default     = []
}

variable "system_service_principals" {
  description = "Machine services, by name, whose role's assumed-role sessions may call /v1/system/services/* with SigV4. A service's holds and entitlement grant belong to source service:<name>. grants: organization-read, organization-holds, organization-entitlements. Empty adds no route."
  type = map(object({
    role_arn = string
    grants   = set(string)
  }))
  default = {}
}
