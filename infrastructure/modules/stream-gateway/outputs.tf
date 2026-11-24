output "base_url" {
  description = "Public stream gateway base URL. Derived only from domain_name so dependent modules avoid cycles."
  value       = "https://${var.domain_name}"
}

output "cluster_arn" {
  description = "Stream gateway ECS cluster ARN."
  value       = aws_ecs_cluster.runtime.arn
}

output "load_balancer_arn_suffix" {
  description = "ARN suffix of the load balancer fronting the gateway: the dedicated public ALB, or the shared internal ALB behind CloudFront."
  value       = local.load_balancer_arn_suffix
}

output "service_name" {
  description = "Stream gateway ECS service name."
  value       = aws_ecs_service.service.name
}

output "service_security_group_id" {
  description = "Security group attached to stream gateway tasks."
  value       = aws_security_group.service.id
}
