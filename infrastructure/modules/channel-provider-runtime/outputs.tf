output "api_endpoint" {
  description = "Channel webhook and authenticated credential-management HTTP API endpoint."
  value       = aws_apigatewayv2_api.public.api_endpoint
}

output "credential_writer_policy_arn" {
  description = "IAM policy for the authenticated platform API credential create/rotate/revoke path."
  value       = aws_iam_policy.credential_writer.arn
}

output "credential_vault_role_arns" {
  description = "Tenant-scoped STS roles used for credential-vault reader and writer sessions."
  value       = { for access, role in aws_iam_role.credential_vault : access => role.arn }
}

output "channel_delivery_role_arn" {
  description = "Platform Lambda role that vertical-owned RCS delivery roles must trust."
  value       = aws_iam_role.runtime["channel-delivery"].arn
}

output "queue_arns" {
  description = "Channel/provider runtime queue ARNs."
  value       = { for key, queue in aws_sqs_queue.runtime : key => queue.arn }
}

output "queue_urls" {
  description = "Channel/provider runtime queue URLs."
  value       = { for key, queue in aws_sqs_queue.runtime : key => queue.url }
}

output "oauth_refresh_function_name" {
  description = "IAM-invoked single-flight OAuth token refresh Lambda name."
  value       = aws_lambda_function.oauth_refresh.function_name
}

output "oauth_refresh_function_arn" {
  description = "IAM-invoked single-flight OAuth token refresh Lambda ARN."
  value       = aws_lambda_function.oauth_refresh.arn
}

output "oauth_public_origin" {
  description = "Exact https origin serving channel ingress, OAuth callbacks, and the vendor MCP client metadata document: the custom domain when one is set."
  value       = local.public_origin
}
