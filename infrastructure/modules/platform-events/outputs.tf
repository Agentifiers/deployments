output "event_bus_arn" {
  description = "ARN of the standalone semantic EventBridge bus."
  value       = aws_cloudwatch_event_bus.semantic.arn
}

output "event_bus_name" {
  description = "Name of the standalone semantic EventBridge bus."
  value       = aws_cloudwatch_event_bus.semantic.name
}

output "event_dispatcher_failure_bucket_arn" {
  description = "ARN of the bucket retaining exhausted semantic event stream payloads."
  value       = aws_s3_bucket.dispatcher_failures.arn
}

output "event_dispatcher_function_arn" {
  description = "ARN of the semantic event DynamoDB Streams dispatcher."
  value       = aws_lambda_function.dispatcher.arn
}
