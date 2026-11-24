output "api_endpoint" {
  description = "JWT-protected public memory API endpoint."
  value       = aws_apigatewayv2_api.memory.api_endpoint
}

output "api_function_invoke_arn" {
  description = "Invoke ARN of the memory API Lambda."
  value       = aws_lambda_function.runtime["memory-api"].invoke_arn
}

output "api_function_name" {
  description = "Function name of the memory API Lambda."
  value       = aws_lambda_function.runtime["memory-api"].function_name
}

output "erasure_function_arn" {
  description = "ARN of the internal provider-erasure Lambda."
  value       = aws_lambda_function.runtime["memory-erasure"].arn
}

output "erasure_function_name" {
  description = "Name of the internal provider-erasure Lambda."
  value       = aws_lambda_function.runtime["memory-erasure"].function_name
}

output "membership_secret_arn" {
  description = "SecureString parameter used to pseudonymize memory target membership receipts."
  value       = aws_ssm_parameter.memory_membership.arn
}

output "queue_arns" {
  description = "Memory runtime queue ARNs."
  value       = { for name, queue in aws_sqs_queue.runtime : name => queue.arn }
}

output "queue_urls" {
  description = "Memory runtime queue URLs."
  value       = { for name, queue in aws_sqs_queue.runtime : name => queue.url }
}

output "worker_runtime_configuration" {
  description = "Environment variables required to use memory recall from the agent worker."
  value = {
    DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET          = var.blob_bucket_name
    DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS = tostring(var.embedding_dimensions)
    DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL      = var.embedding_model
    DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT  = var.aws_native_enabled ? var.opensearch_endpoint : ""
    DEPLOYMENTS_AI_MEMORY_RERANK_MODEL         = var.rerank_model
  }
}

output "worker_aws_native_policy_arn" {
  description = "IAM policy allowing the agent worker to query AWS-native memory search."
  value       = var.aws_native_enabled ? aws_iam_policy.worker_aws_native[0].arn : null
}

output "search_placement_function_name" {
  description = "Function that activates default memory search for an organization, or one page of every organization with {\"organizations\": \"all\"}."
  value       = aws_lambda_function.runtime["memory-search-placement"].function_name
}
