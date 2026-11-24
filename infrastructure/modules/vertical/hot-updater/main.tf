locals {
  raw_project_name    = trim(replace(replace(lower(var.project_name), "/[^a-z0-9-]+/", "-"), "/-{2,}/", "-"), "-")
  project_name        = local.raw_project_name != "" ? local.raw_project_name : "deployments-ai"
  raw_app_slug        = trim(replace(replace(lower(var.app_slug), "/[^a-z0-9-]+/", "-"), "/-{2,}/", "-"), "-")
  app_slug_fallback   = local.raw_app_slug != "" ? local.raw_app_slug : "mobile-app"
  normalized_app_slug = can(regex("^[a-z]", local.app_slug_fallback)) ? local.app_slug_fallback : "app-${local.app_slug_fallback}"
  name_prefix         = trimsuffix(substr("${local.project_name}-ota-${var.stage}-${local.normalized_app_slug}", 0, 54), "-")
  name_suffix         = substr(sha256(trimspace(var.app_id)), 0, 8)
  base_name           = "${local.name_prefix}-${local.name_suffix}"
  worker_content      = sensitive(file(var.worker_bundle_path))
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "cloudflare_r2_bucket" "bundles" {
  account_id = var.account_id
  name       = local.base_name
}

resource "cloudflare_d1_database" "metadata" {
  account_id = var.account_id
  name       = local.base_name
  # D1 updates require an explicit replication object, even for the default disabled mode.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_script" "updater" {
  account_id          = var.account_id
  script_name         = local.base_name
  compatibility_date  = "2025-01-24"
  compatibility_flags = ["nodejs_compat"]
  main_module         = "index.js"
  content             = local.worker_content
  content_type        = "application/javascript+module"

  bindings = [
    {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.metadata.id
    },
    {
      name        = "BUCKET"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.bundles.name
    },
    {
      name = "JWT_SECRET"
      type = "secret_text"
      text = random_password.jwt_secret.result
    }
  ]
}

resource "cloudflare_workers_script_subdomain" "updater" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.updater.script_name
  enabled     = true
  # OTA uses the stable workers.dev URL; preview prefixes exceed the DNS limit for long app names.
  previews_enabled = false
}
