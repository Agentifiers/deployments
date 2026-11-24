output "bucket_name" {
  description = "S3 bucket that stores published releases."
  value       = aws_s3_bucket.releases.bucket
}

output "bucket_arn" {
  description = "ARN of the release bucket."
  value       = aws_s3_bucket.releases.arn
}

output "signing_key_arn" {
  description = "KMS key that signs release records."
  value       = aws_kms_key.signing.arn
}

output "signing_key_alias" {
  description = "KMS alias of the release record signing key."
  value       = aws_kms_alias.signing.name
}

output "publisher_role_arn" {
  description = "Role GitHub Actions assumes to publish releases."
  value       = aws_iam_role.publisher.arn
}

output "reader_policy_arn" {
  description = "Managed policy to attach to identities that read, retain, and pull releases."
  value       = aws_iam_policy.reader.arn
}

output "deployer_repository_url" {
  description = "ECR repository URL of the deployer image."
  value       = aws_ecr_repository.deployer.repository_url
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider the publisher role trusts."
  value       = local.github_oidc_provider_arn
}
