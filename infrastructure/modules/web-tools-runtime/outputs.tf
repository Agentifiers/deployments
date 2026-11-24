output "base_url" {
  description = "Private HTTPS base URL for the self-hosted Firecrawl API."
  value       = "https://${var.domain_name}"
}

output "chromium_dns_name" {
  description = "Cloud Map DNS name of the Chromium fallback renderer service."
  value       = local.chromium_dns_name
}

output "chromium_service_name" {
  description = "Chromium fallback renderer ECS service name."
  value       = aws_ecs_service.chromium.name
}

output "cluster_arn" {
  description = "Shared ECS cluster hosting the Firecrawl task."
  value       = var.ecs_cluster_arn
}

output "dynamodb_table_arn" {
  description = "DynamoDB table holding Firecrawl's queue and crawl, extract, deep research and llms.txt state."
  value       = aws_dynamodb_table.firecrawl.arn
}

output "dynamodb_table_name" {
  description = "DynamoDB table holding Firecrawl's queue and crawl, extract, deep research and llms.txt state."
  value       = aws_dynamodb_table.firecrawl.name
}

output "job_ticket_secret_arn" {
  description = "SSM SecureString parameter ARN containing the hosted-agent Firecrawl job-ticket key."
  value       = aws_ssm_parameter.runtime["firecrawl-job-ticket"].arn
}

output "service_name" {
  description = "Firecrawl ECS service name."
  value       = aws_ecs_service.firecrawl.name
}

output "target_group_arn" {
  description = "Private Firecrawl ALB target group ARN."
  value       = aws_lb_target_group.firecrawl.arn
}

output "task_definition_arn" {
  description = "Firecrawl task definition ARN."
  value       = aws_ecs_task_definition.firecrawl.arn
}
