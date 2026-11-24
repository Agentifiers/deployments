output "app_id" {
  value = var.app_id
}

output "base_name" {
  value = local.base_name
}

output "d1_database_id" {
  value = cloudflare_d1_database.metadata.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.metadata.name
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.bundles.name
}

output "worker_name" {
  value = cloudflare_workers_script.updater.script_name
}

output "worker_url" {
  value      = "https://${cloudflare_workers_script.updater.script_name}.${var.workers_subdomain}.workers.dev/api/check-update"
  depends_on = [cloudflare_workers_script_subdomain.updater]
}

output "workers_subdomain" {
  value = var.workers_subdomain
}
