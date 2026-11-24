output "api_endpoint" {
  description = "Canonical base URL of the unified public product API."
  value       = "https://${lower(trimspace(var.domain_name))}"
}

output "api_id" {
  description = "ID of the unified public product HTTP API."
  value       = aws_apigatewayv2_api.public.id
}

output "execute_api_endpoint" {
  description = "Disabled AWS-managed execute-api URL retained for diagnostics and resource identification."
  value       = aws_apigatewayv2_api.public.api_endpoint
}

output "function_arn" {
  description = "ARN of the tenancy and agent lifecycle API Lambda."
  value       = aws_lambda_function.api["tenancy"].arn
}

output "function_name" {
  description = "Name of the tenancy and agent lifecycle API Lambda."
  value       = aws_lambda_function.api["tenancy"].function_name
}

output "functions" {
  description = "Name and ARN of every platform API Lambda, keyed by route family."
  value = {
    for key, api in aws_lambda_function.api : key => {
      arn  = api.arn
      name = api.function_name
    }
  }
}

output "e2e_callback_function_arn" {
  description = "ARN of the development-only deterministic HTTP callback fixture Lambda when enabled."
  value       = var.e2e_callback_fixture_enabled ? aws_lambda_function.e2e_callback[0].arn : null
}

output "e2e_mcp_function_arn" {
  description = "ARN of the development-only deterministic MCP fixture Lambda when enabled."
  value       = var.e2e_mcp_fixture_enabled ? aws_lambda_function.e2e_mcp[0].arn : null
}

output "role_arn" {
  description = "Least-privilege execution role ARN shared by every platform API Lambda."
  value       = aws_iam_role.lambda.arn
}

output "model_credential_kms_key_arn" {
  description = "ARN of the KMS key that seals organization model provider keys, or null when no provider is enabled. The API can only encrypt with it."
  value       = local.model_credential_key_arn
}
