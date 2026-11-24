mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-2" }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-2:123456789012:mockapi" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-2:123456789012:rule/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:deployments-ai-dev-agent-runtime-function" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-2:123456789012:deployments-ai-dev-agent-runtime-queue.fifo"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/deployments-ai-dev-agent-runtime-queue.fifo"
    }
  }
}

variables {
  alert_email = {
    console_origin = "https://console.example.com"
    sender         = "alerts@mail.example.com"
  }
  agent_worker_image                  = "123456789012.dkr.ecr.us-east-2.amazonaws.com/agent-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  alarm_topic_arn                     = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  api_throttling_burst_limit          = 100
  api_throttling_rate_limit           = 50
  artifact_bucket_arn                 = "arn:aws:s3:::deployments-ai-dev-artifacts-123456789012"
  artifact_bucket_name                = "deployments-ai-dev-artifacts-123456789012"
  data_kms_key_arn                    = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  deletion_protection_enabled         = false
  durable_streams_auth_secret_arn     = "arn:aws:ssm:us-east-2:123456789012:parameter/deployments-ai/dev/durable-streams/auth-token"
  document_extraction_function_arn    = "arn:aws:lambda:us-east-2:123456789012:function:deployments-ai-dev-document-extraction"
  document_extraction_function_name   = "deployments-ai-dev-document-extraction"
  durable_streams_base_url            = "http://durable-streams.deployments-ai-dev.internal:4437"
  ecs_cluster_arn                     = "arn:aws:ecs:us-east-2:123456789012:cluster/deployments-ai-dev"
  environment                         = "dev"
  event_bus_name                      = "deployments-ai-dev-semantic-events"
  execution_table_stream_arn          = "arn:aws:dynamodb:us-east-2:123456789012:table/execution/stream/2026-01-01T00:00:00.000"
  fargate_spot_enabled                = false
  lambda_artifact_bucket              = "deployments-ai-dev-artifacts-123456789012"
  lambda_artifact_key                 = "agent-runtime.zip"
  lambda_artifact_version             = "version-1"
  log_retention_in_days               = 30
  model_gateway_base_url              = "http://model-gateway.deployments-ai-dev.internal"
  model_gateway_token_signing_key_arn = "arn:aws:kms:us-east-2:123456789012:key/33333333-3333-3333-3333-333333333333"
  model_grants_parameter_arn          = "arn:aws:ssm:us-east-2:123456789012:parameter/deployments-ai/dev/model-grants"
  model_token_service_fallback_models = []
  model_token_service_models = {
    agent_worker = []
    brain        = []
    memory       = []
    web_tools    = []
  }
  private_subnet_ids              = ["subnet-00000000000000001"]
  request_admission_table_arn     = "arn:aws:dynamodb:us-east-2:123456789012:table/request-admission"
  request_admission_table_name    = "request-admission"
  tenant_limit_defaults_json      = "{}"
  usage_table_stream_arn          = "arn:aws:dynamodb:us-east-2:123456789012:table/usage/stream/2026-01-01T00:00:00.000"
  vpc_id                          = "vpc-00000000000000001"
  webhook_delivery_retention_days = 30
  worker_cpu                      = 1024
  worker_max_concurrent_runs      = 4
  worker_max_count                = 2
  worker_memory                   = 2048
  worker_min_count                = 1
  dynamodb_table_arns = {
    control   = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
    events    = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
    execution = "arn:aws:dynamodb:us-east-2:123456789012:table/execution"
    usage     = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
  }
  dynamodb_table_names = {
    control   = "control"
    events    = "events"
    execution = "execution"
    usage     = "usage"
  }
  # The padding sizes the shared worker environment like the dev install's, 4,085 bytes with the
  # quotas, where the workflow queue and event router pass 4,096 bytes if they carry the quotas.
  runtime_environment_variables = {
    DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS = "{\"hourlyIssuance\":{\"caller\":1000,\"organization\":10000},\"outstandingBytes\":{\"brain\":10737418240,\"caller\":2147483648,\"organization\":53687091200},\"outstandingTickets\":{\"brain\":1000,\"caller\":100,\"organization\":5000}}"
    DEPLOYMENTS_AI_INSTALL_PADDING     = format("%01506d", 0)
  }
}

run "alerts_sweep_one_invocation_per_shard" {
  command = plan

  assert {
    condition = sort([for target in aws_cloudwatch_event_target.alerts_sweep : target.input]) == sort([
      for shard in range(16) : jsonencode({ shard = shard, sweep = true })
    ])
    error_message = "Each of the 16 monitor sweep shards needs its own schedule target with input { sweep = true, shard = n }."
  }

  assert {
    condition     = length(aws_lambda_permission.alerts_sweep) == 16
    error_message = "Every shard's schedule must be allowed to invoke the alerts function."
  }

  assert {
    condition = contains(
      [for query in aws_cloudwatch_metric_alarm.alerts_errors[0].metric_query : try(query.metric[0].metric_name, "")],
      "MonitorEvaluationFailures",
    )
    error_message = "The alerts error alarm must count monitors the sweep failed to evaluate."
  }
}

run "alerts_grants_match_what_the_function_does" {
  command = plan

  assert {
    condition = toset(one([
      for statement in data.aws_iam_policy_document.alerts[0].statement : statement.resources if statement.sid == "AlertEmail"
      ])) == toset([
      "arn:aws:ses:us-east-2:123456789012:identity/mail.example.com",
      "arn:aws:ses:us-east-2:123456789012:identity/alerts@mail.example.com",
    ])
    error_message = "Alert email must be allowed through the sender's domain identity and its address identity."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.alerts[0].statement :
      !contains(statement.actions, "dynamodb:PutItem") || !anytrue([for resource in statement.resources : strcontains(resource, "table/execution")])
    ])
    error_message = "The alerts function only reads the execution table."
  }
}
