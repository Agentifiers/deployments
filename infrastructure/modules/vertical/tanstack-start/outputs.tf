output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "function_arn" {
  value = module.function.arn
}

output "function_name" {
  value = module.function.function_name
}

output "function_role_arn" {
  value = module.function.role_arn
}

output "url" {
  description = "Public URL of the default HTTP API stage."
  value       = aws_apigatewayv2_api.this.api_endpoint
}
