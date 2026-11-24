output "url" {
  description = "Public HTTPS origin serving the console."
  value       = var.application_origin
}

output "assets_bucket_name" {
  description = "Private S3 bucket the deploy tool uploads console static assets to."
  value       = aws_s3_bucket.assets.bucket
}

output "distribution_domain_name" {
  description = "CloudFront domain name; point the application origin host here when DNS is managed outside this stack."
  value       = aws_cloudfront_distribution.console.domain_name
}

output "distribution_id" {
  description = "CloudFront distribution serving the console."
  value       = aws_cloudfront_distribution.console.id
}

output "function_arn" {
  description = "ARN of the console server Lambda."
  value       = aws_lambda_function.console.arn
}
