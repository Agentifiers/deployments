output "service_name" {
  value = aws_ecs_service.this.name
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "service_url" {
  value = var.route_prefix
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "target_group_arn" {
  value = try(aws_lb_target_group.this[0].arn, null)
}

output "execution_secret_arns" {
  description = "Parameter ARNs the execution role may read for ECS secret injection."
  value       = local.all_secret_arns
}
