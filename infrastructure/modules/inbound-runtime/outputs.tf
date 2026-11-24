output "channel_command_function_arn" {
  description = "Channel ingress command consumer Lambda ARN."
  value       = aws_lambda_function.runtime.arn
}

output "channel_ingress_flush_function_arn" {
  description = "Channel ingress quiet-window flush Lambda ARN."
  value       = aws_lambda_function.flush.arn
}

output "channel_ingress_flush_role_arn" {
  description = "Flush Lambda role that the credential-vault reader role must trust."
  value       = aws_iam_role.flush.arn
}
