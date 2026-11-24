output "bucket_name" {
  description = "Private S3 bucket holding published preview sites."
  value       = aws_s3_bucket.sites.bucket
}

output "distribution_id" {
  description = "CloudFront distribution serving preview sites."
  value       = aws_cloudfront_distribution.sites.id
}

output "origin" {
  description = "Public HTTPS origin serving preview sites."
  value       = "https://${var.domain_name}"
}

output "publisher_policy_json" {
  description = "IAM policy granting vertical preview publication under verticals/ and CloudFront invalidation. Not attached to any principal."
  value       = data.aws_iam_policy_document.publisher.json
}
