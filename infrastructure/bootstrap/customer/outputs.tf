output "state_bucket_name" {
  description = "OpenTofu state bucket; the deployment target's terraform.stateBucket."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "Role deploy_principal_arn assumes to run deploys, presenting external_id when one is set."
  value       = aws_iam_role.deploy.arn
}

output "observer_role_arn" {
  description = "Role observer_principal_arn assumes to read the observer routes; list it in system_observer_role_arns. Null when observer_principal_arn is null."
  value       = one(aws_iam_role.observer[*].arn)
}

output "permissions_boundary_arn" {
  description = "Permissions boundary every platform role carries; the customer root's iam_permissions_boundary_arn."
  value       = aws_iam_policy.workload_boundary.arn
}
