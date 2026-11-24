output "bucket_name" {
  description = "Private S3 bucket holding the exported site."
  value       = aws_s3_bucket.site.bucket
}

output "bucket_region" {
  description = "AWS region of the site bucket."
  value       = aws_s3_bucket.site.region
}

output "distribution_id" {
  description = "CloudFront distribution serving the site."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "CloudFront domain name the site hostname aliases."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  description = "Public HTTPS origin of the site."
  value       = "https://${var.domain_name}"
}
