output "function_arn" {
  description = "ARN of the document extraction Lambda; invokers grant themselves lambda:InvokeFunction on it."
  value       = aws_lambda_function.document_extraction.arn
}

output "function_name" {
  description = "Name of the document extraction Lambda."
  value       = aws_lambda_function.document_extraction.function_name
}
