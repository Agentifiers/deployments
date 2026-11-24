output "bedrock_region" {
  description = "Region Bifrost uses for Amazon Bedrock when bedrock is hosted; null otherwise."
  value       = local.bedrock_hosted ? data.aws_region.current.region : null
}

output "hosted_providers" {
  description = "Hosted model providers, sorted."
  value       = sort(tolist(var.hosted_providers))

  # The deploy tool seeds parameters after a targeted apply of the parameters and the region data
  # source; this dependency refreshes the output in that apply.
  depends_on = [data.aws_region.current]
}

output "model_gateway_base_url" {
  description = "Private model gateway origin; OpenAI-compatible clients append /v1."
  value       = local.model_gateway_base_url
}

output "model_grants_parameter_arn" {
  description = "SSM parameter ARN holding the operator model grants JSON."
  value       = aws_ssm_parameter.runtime["model-grants-json"].arn
}

output "service_name" {
  description = "Model gateway ECS service name."
  value       = aws_ecs_service.gateway.name
}

output "task_role_arn" {
  description = "Task role shared by the model gateway and Bifrost; the only role the organization model credential key lets decrypt."
  value       = aws_iam_role.task.arn
}

output "token_signing_key_arn" {
  description = "KMS key ARN that token issuers sign model gateway tokens with."
  value       = aws_kms_key.token_signing.arn
}

output "private_subnet_ids" {
  description = "Private subnet IDs for model gateway callers."
  value       = var.private_subnet_ids
}

output "secret_arns" {
  description = "SecureString parameters (provider API keys and model grants) the deploy tool populates before starting the gateway."
  value       = { for name, parameter in aws_ssm_parameter.runtime : name => parameter.arn }
}

output "gateway_security_group_id" {
  description = "Security group of the model gateway tasks, which make every upstream provider call."
  value       = aws_security_group.gateway.id
}

output "vpc_id" {
  description = "Model runtime VPC ID."
  value       = var.vpc_id
}

output "ecs_cluster_arn" {
  description = "Shared private ECS cluster hosting the model gateway and small adjacent runtime services. Registers the FARGATE and FARGATE_SPOT capacity providers."
  value       = aws_ecs_cluster.runtime.arn

  # Services placed on this cluster use capacity provider strategies, which need the providers registered first.
  depends_on = [aws_ecs_cluster_capacity_providers.runtime]
}

output "internal_load_balancer" {
  description = "Shared private application load balancer metadata for adjacent runtime listeners."
  value = {
    arn               = aws_lb.internal.arn
    arn_suffix        = aws_lb.internal.arn_suffix
    dns_name          = aws_lb.internal.dns_name
    security_group_id = aws_security_group.alb.id
    zone_id           = aws_lb.internal.zone_id
  }
}
