output "worker_cluster_arn" {
  description = "ECS cluster ARN hosting the agent worker service."
  value       = var.ecs_cluster_arn
}

output "worker_service_name" {
  description = "ECS service name of the agent worker."
  value       = aws_ecs_service.agent_worker.name
}

output "worker_task_definition_arn" {
  description = "Agent worker task definition revision the service was last deployed with."
  value       = aws_ecs_task_definition.agent_worker.arn
}

output "api_endpoint" {
  description = "Public hosted-agent runtime HTTP API endpoint."
  value       = aws_apigatewayv2_api.runtime.api_endpoint
}

output "api_function_invoke_arn" {
  description = "Invoke ARN of the hosted-agent runtime API Lambda."
  value       = aws_lambda_function.api.invoke_arn
}

output "api_function_name" {
  description = "Function name of the hosted-agent runtime API Lambda."
  value       = aws_lambda_function.api.function_name
}

output "heartbeat_fire_function_arn" {
  description = "EventBridge Scheduler heartbeat fire Lambda ARN."
  value       = aws_lambda_function.heartbeat_fire.arn
}

output "end_user_subject_key_arn" {
  description = "SSM SecureString parameter ARN of the end-user subject HMAC key."
  value       = aws_ssm_parameter.end_user_subject.arn
}

output "schedule_fire_function_arn" {
  description = "EventBridge Scheduler schedule fire Lambda ARN."
  value       = aws_lambda_function.schedule_fire.arn
}

output "scheduler_group_name" {
  description = "EventBridge Scheduler group for agent automations."
  value       = aws_scheduler_schedule_group.runtime.name
}

output "stream_session_secret_arn" {
  description = "SSM SecureString parameter ARN used to sign public stream sessions."
  value       = aws_ssm_parameter.stream_session.arn
}

output "queue_arn" {
  description = "Agent run FIFO queue ARN."
  value       = aws_sqs_queue.runs.arn
}

output "queue_url" {
  description = "Agent run FIFO queue URL used by the conversation API."
  value       = aws_sqs_queue.runs.url
}

output "evaluation_queue_arn" {
  description = "Evaluation FIFO queue ARN."
  value       = aws_sqs_queue.evaluations.arn
}

output "evaluation_queue_url" {
  description = "Evaluation FIFO queue URL used by the platform API and evaluation workers."
  value       = aws_sqs_queue.evaluations.url
}

output "usage_materializer_function_arn" {
  description = "Usage materializer Lambda ARN."
  value       = aws_lambda_function.usage.arn
}

output "automation_failure_queue_arn" {
  description = "Queue containing automation fire invocations that exhausted Lambda retries."
  value       = aws_sqs_queue.automation_failures.arn
}

output "model_token_issuers" {
  description = "Model gateway token issuer Lambdas by caller class: run, agent-worker, evaluations, memory, brain, web-tools."
  value = {
    for name, function in aws_lambda_function.model_token_issuer : name => {
      arn           = function.arn
      function_name = function.function_name
    }
  }
}
