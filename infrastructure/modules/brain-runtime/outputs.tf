output "query_policy_arn" {
  description = "IAM policy allowing platform API and agent workers to query Brain search."
  value       = aws_iam_policy.query.arn
}

output "erasure_function_arn" {
  description = "ARN of the internal Brain provider-erasure Lambda."
  value       = aws_lambda_function.erasure.arn
}

output "erasure_function_name" {
  description = "Name of the internal Brain provider-erasure Lambda."
  value       = aws_lambda_function.erasure.function_name
}

output "runtime_configuration" {
  description = "Environment variables required by Brain query runtimes; each runtime supplies its own model gateway credentials."
  value = merge({
    DEPLOYMENTS_AI_BRAIN_ANSWER_MODEL           = var.answer_model
    DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT    = local.opensearch_endpoint
    DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_content_bucket_names)
  }, local.upload_quotas_environment)
}

output "search_placement_function_name" {
  description = "Function that activates default Brain search for an organization, or one page of every organization with {\"organizations\": \"all\"}."
  value       = aws_lambda_function.search_placement.function_name
}
