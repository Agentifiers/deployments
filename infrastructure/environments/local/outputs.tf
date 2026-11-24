locals {
  queue_urls = {
    for name, queue in aws_sqs_queue.runtime :
    name => replace(queue.url, "http://localhost:4566", trimsuffix(var.aws_endpoint_url, "/"))
  }
  runtime_environment = {
    AWS_ACCESS_KEY_ID                              = "local"
    AWS_DEFAULT_REGION                             = var.aws_region
    AWS_EC2_METADATA_DISABLED                      = "true"
    AWS_ENDPOINT_URL                               = var.aws_endpoint_url
    AWS_ENDPOINT_URL_DYNAMODB                      = var.aws_endpoint_url
    AWS_ENDPOINT_URL_EVENTBRIDGE                   = var.aws_endpoint_url
    AWS_ENDPOINT_URL_EVENTS                        = var.aws_endpoint_url
    AWS_ENDPOINT_URL_S3                            = var.aws_endpoint_url
    AWS_ENDPOINT_URL_SECRETS_MANAGER               = var.aws_endpoint_url
    AWS_ENDPOINT_URL_SQS                           = var.aws_endpoint_url
    AWS_ENDPOINT_URL_STS                           = var.aws_endpoint_url
    AWS_REGION                                     = var.aws_region
    AWS_SECRET_ACCESS_KEY                          = "local"
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL             = local.queue_urls["agent-run"]
    DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET              = aws_s3_bucket.agent_email.id
    DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL    = local.queue_urls["agent-email-events"]
    DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_QUEUE_URL   = local.queue_urls["agent-email-inbound"]
    DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL      = local.queue_urls["agent-email-send"]
    DEPLOYMENTS_AI_CHANNEL_DELIVERY_QUEUE_URL      = local.queue_urls["channel-delivery"]
    DEPLOYMENTS_AI_CHANNEL_INGRESS_FLUSH_QUEUE_URL = local.queue_urls["channel-ingress-flush"]
    DEPLOYMENTS_AI_CHANNEL_INGRESS_QUEUE_URL       = local.queue_urls["channel-ingress"]
    DEPLOYMENTS_AI_CONTROL_TABLE                   = aws_dynamodb_table.platform["control"].name
    DEPLOYMENTS_AI_EVENTS_TABLE                    = aws_dynamodb_table.platform["events"].name
    DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN        = aws_secretsmanager_secret.runtime["end-user-subject-key"].arn
    DEPLOYMENTS_AI_EVENT_BUS_NAME                  = aws_cloudwatch_event_bus.semantic.name
    DEPLOYMENTS_AI_EXECUTION_TABLE                 = aws_dynamodb_table.platform["execution"].name
    DEPLOYMENTS_AI_IDENTITY_TABLE                  = aws_dynamodb_table.platform["identity"].name
    DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE     = aws_dynamodb_table.platform["identity-email-outbox"].name
    DEPLOYMENTS_AI_MEMORY_FLUSH_QUEUE_URL          = local.queue_urls["memory-flush"]
    DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET              = aws_s3_bucket.artifacts.id
    DEPLOYMENTS_AI_MEMORY_CURSOR_KEY_HEX           = local.memory_cursor_key_hex
    DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL          = local.queue_urls["memory-index"]
    DEPLOYMENTS_AI_MEMORY_SHADOW_QUEUE_URL         = local.queue_urls["memory-shadow"]
    DEPLOYMENTS_AI_MEMORY_USAGE_QUEUE_URL          = local.queue_urls["memory-usage"]
    DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL      = local.queue_urls["memory-operation"]
    DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN    = aws_secretsmanager_secret.runtime["memory-membership-hmac-key"].arn
    DEPLOYMENTS_AI_MEMORY_API_ENDPOINT             = aws_apigatewayv2_api.memory.api_endpoint
    DEPLOYMENTS_AI_PROVIDER_TOOLS_QUEUE_URL        = local.queue_urls["provider-tools"]
    DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE         = aws_dynamodb_table.request_admission.name
    DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS           = local.tenant_limit_defaults_json
    DEPLOYMENTS_AI_USAGE_TABLE                     = aws_dynamodb_table.platform["usage"].name
  }
}

output "agent_email_bucket_name" {
  value = aws_s3_bucket.agent_email.id
}

output "artifact_bucket_name" {
  value = aws_s3_bucket.artifacts.id
}

output "aws_endpoint_url" {
  value = var.aws_endpoint_url
}

output "dynamodb_table_names" {
  value = { for name, table in aws_dynamodb_table.platform : name => table.name }
}

output "dynamodb_table_stream_arns" {
  value = {
    for name, table in aws_dynamodb_table.platform : name => table.stream_arn
    if table.stream_enabled
  }
}

output "queue_arns" {
  value = { for name, queue in aws_sqs_queue.runtime : name => queue.arn }
}

output "memory_api_endpoint" {
  description = "JWT-protected local memory API endpoint."
  value       = aws_apigatewayv2_api.memory.api_endpoint
}

output "queue_urls" {
  value = local.queue_urls
}

output "runtime_environment" {
  description = "Environment variables for running platform processes against local AWS."
  value       = local.runtime_environment
}

output "secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn }
}

output "semantic_event_bus_arn" {
  value = aws_cloudwatch_event_bus.semantic.arn
}

output "semantic_event_bus_name" {
  value = aws_cloudwatch_event_bus.semantic.name
}
