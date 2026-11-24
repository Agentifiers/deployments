output "bucket_name" {
  description = "Apps bucket: apps/<appId>/releases/<releaseId>/ for release files, apps/<appId>/exports/<exportId>/ for exports."
  value       = aws_s3_bucket.apps.bucket
}

output "callers" {
  description = "Environment and IAM policies for the worker, the API, and the governance worker, which reach app databases only through the apps-database Lambda."
  value = {
    environment = {
      APPS_BUCKET                 = aws_s3_bucket.apps.bucket
      APPS_DATABASE_FUNCTION_NAME = aws_lambda_function.database.function_name
      APPS_DOMAIN                 = var.domain
    }
    dev_session_policy_arn    = aws_iam_policy.dev_sessions.arn
    export_read_policy_arn    = aws_iam_policy.export_read.arn
    invoke_policy_arn         = aws_iam_policy.database_invoke.arn
    release_upload_policy_arn = aws_iam_policy.release_upload.arn
  }
}

output "client_security_group_ids" {
  description = "Security group IDs of the components allowed to reach the apps cluster, keyed by database-function and gateway."
  value       = { for key, group in aws_security_group.client : key => group.id }
}

output "cluster_arn" {
  value = aws_rds_cluster.apps.arn
}

output "cluster_resource_id" {
  description = "Cluster resource ID that rds-db:connect resource ARNs name."
  value       = aws_rds_cluster.apps.cluster_resource_id
}

output "custom_domains" {
  description = "Multi-tenant distribution and connection group that app domain tenants join; a domain's CNAME targets the routing endpoint."
  value = {
    connection_group_id = aws_cloudfront_connection_group.custom_domains.id
    distribution_arn    = aws_cloudfront_multitenant_distribution.custom_domains.arn
    distribution_id     = aws_cloudfront_multitenant_distribution.custom_domains.id
    routing_endpoint    = aws_cloudfront_connection_group.custom_domains.routing_endpoint
  }
}

output "database_function_name" {
  value = aws_lambda_function.database.function_name
}

output "domain" {
  value = var.domain
}

output "domain_reconciler_function_name" {
  value = aws_lambda_function.domain_reconciler.function_name
}

output "domain_reconciler_invoke_policy_arn" {
  description = "Policy that lets the platform API ask the apps-domains Lambda to converge one domain now."
  value       = aws_iam_policy.domain_reconciler_invoke.arn
}

output "master_user_secret_arn" {
  description = "RDS-managed master secret, read only by the deploy pipeline's Data API cluster bootstrap."
  value       = aws_rds_cluster.apps.master_user_secret[0].secret_arn
}

output "oauth_client" {
  description = "Confidential OAuth client the deploy pipeline seeds for the gateway's sign-in."
  value = {
    client_id    = local.oauth_client_id
    redirect_uri = "https://${var.domain}/_platform/auth/callback"
    secret_arn   = local.oauth_client_secret_arn
  }
}

output "port" {
  value = aws_rds_cluster.apps.port
}

output "writer_endpoint" {
  value = aws_rds_cluster.apps.endpoint
}
