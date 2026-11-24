output "auth_token_secret_arn" {
  description = "SecureString parameter containing the internal Durable Streams authentication token."
  value       = aws_ssm_parameter.auth_token.arn
}

output "base_url" {
  description = "Private Durable Streams base URL for VPC-attached API and worker runtimes."
  value       = local.uses_shared_load_balancer ? "http://${var.shared_load_balancer.dns_name}:4437" : "http://${aws_lb.internal[0].dns_name}"
}

output "cluster_arn" {
  description = "Durable Streams ECS cluster ARN."
  value       = aws_ecs_cluster.runtime.arn
}

output "service_name" {
  description = "Durable Streams ECS service name."
  value       = aws_ecs_service.service.name
}

output "service_security_group_id" {
  description = "Security group attached to Durable Streams tasks."
  value       = aws_security_group.service.id
}
