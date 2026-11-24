# OpenTofu mocks give computed attributes generated values at plan, so every ARN the
# provider validates at plan comes from a mock default here.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-2:123456789012:mockapi" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-2:123456789012:rule/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:123456789012:log-group:mock" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:mock" }
  }
}

variables {
  account_id                      = "123456789012"
  alarm_topic_arn                 = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  agent_email_bucket_arn          = "arn:aws:s3:::agent-email"
  agent_email_bucket_name         = "agent-email"
  artifact_bucket                 = "artifacts-123456789012"
  artifact_key                    = "platform-api.zip"
  artifact_version                = "version-1"
  automation_scheduler_group_name = "automations"
  brain_erasure_function_arn      = "arn:aws:lambda:us-east-2:123456789012:function:brain-search-erasure"
  brain_erasure_function_name     = "brain-search-erasure"
  brain_runtime_policy_arn        = "arn:aws:iam::123456789012:policy/brain-query"
  certificate_arn                 = "arn:aws:acm:us-east-2:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  control_table_arn               = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name              = "control"
  data_kms_key_arn                = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  detailed_metrics_enabled        = false
  domain_name                     = "api.example.com"
  durable_streams_auth_secret_arn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:durable-streams-AbCdEf"
  durable_streams_base_url        = "http://durable-streams.internal"
  environment                     = "dev"
  evaluation_queue_arn            = "arn:aws:sqs:us-east-2:123456789012:evaluations"
  evaluation_queue_url            = "https://sqs.us-east-2.amazonaws.com/123456789012/evaluations"
  events_table_arn                = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
  events_table_name               = "events"
  governance_bucket_arn           = "arn:aws:s3:::governance"
  governance_bucket_name          = "governance"
  governance_signing_key_arn      = "arn:aws:kms:us-east-2:123456789012:key/33333333-3333-3333-3333-333333333333"
  identity_table_arn              = "arn:aws:dynamodb:us-east-2:123456789012:table/identity"
  identity_table_name             = "identity"
  jwt_audience                    = "platform-api"
  jwt_issuer                      = "https://identity.example.com"
  log_retention_in_days           = 30
  memory_api_function_name        = "memory-api"
  memory_api_invoke_arn           = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:memory-api/invocations"
  memory_erasure_function_arn     = "arn:aws:lambda:us-east-2:123456789012:function:memory-erasure"
  memory_erasure_function_name    = "memory-erasure"
  memory_jwt_audience             = ["memory"]
  memory_jwt_issuer               = "https://identity.example.com"
  oauth_apps_json                 = "{}"
  platform_artifact_bucket_arn    = "arn:aws:s3:::platform-artifacts"
  platform_artifact_bucket_name   = "platform-artifacts"
  request_admission_table_arn     = "arn:aws:dynamodb:us-east-2:123456789012:table/request-admission"
  request_admission_table_name    = "request-admission"
  route53_zone_id                 = "Z0000000000000000000"
  runtime_api_function_name       = "agent-runtime-api"
  runtime_api_invoke_arn          = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:agent-runtime-api/invocations"
  tenant_limit_defaults_json      = "{\"active_sandboxes\":8,\"api_request_burst\":40,\"api_requests_per_second\":20,\"concurrent_runs\":8}"
  test_fixtures_enabled           = false
  throttling_burst_limit          = 100
  throttling_rate_limit           = 50
  usage_table_arn                 = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
  usage_table_name                = "usage"
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
}

run "observer_routes_require_iam_and_admit_listed_roles" {
  command = plan

  variables {
    system_observer_role_arns = [
      "arn:aws:iam::123456789012:role/platform-observer",
      "arn:aws:iam::123456789012:role/vendor/install-reader",
    ]
  }

  assert {
    condition = keys(aws_apigatewayv2_route.system_observer) == [
      "GET /v1/system/observer/alarms",
      "GET /v1/system/observer/components",
      "GET /v1/system/observer/deployments",
      "GET /v1/system/observer/installation",
      "GET /v1/system/observer/model-providers",
    ]
    error_message = "The observer routes must be exactly the five read routes."
  }

  assert {
    condition = alltrue([
      for key, route in aws_apigatewayv2_route.system_observer :
      route.authorization_type == "AWS_IAM" && route.route_key == key
    ])
    error_message = "Every observer route must require SigV4 through AWS_IAM authorization."
  }

  assert {
    condition     = aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS"] == "arn:aws:iam::123456789012:role/platform-observer,arn:aws:iam::123456789012:role/vendor/install-reader"
    error_message = "The system Lambda must receive the observer role ARNs comma-joined."
  }

  assert {
    condition     = aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_AWS_ACCOUNT_ID"] == "123456789012"
    error_message = "The system Lambda must receive its own account ID."
  }
}

run "observer_routes_exist_without_observers" {
  command = plan

  assert {
    condition = alltrue([
      for route in aws_apigatewayv2_route.system_observer : route.authorization_type == "AWS_IAM"
    ]) && length(aws_apigatewayv2_route.system_observer) == 5
    error_message = "The observer routes must exist and require IAM even when no role is listed."
  }

  assert {
    condition = length(setintersection(
      keys(aws_lambda_function.api["system"].environment[0].variables),
      ["DEPLOYMENTS_AI_AWS_ACCOUNT_ID", "DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS"],
    )) == 0
    error_message = "No observer configuration reaches the Lambda when no role is listed."
  }
}

run "rejects_a_role_in_another_account" {
  command = plan

  variables {
    system_observer_role_arns = ["arn:aws:iam::210987654321:role/install-observer"]
  }

  expect_failures = [var.system_observer_role_arns]
}

run "rejects_a_principal_that_is_not_a_role" {
  command = plan

  variables {
    system_observer_role_arns = ["arn:aws:sts::123456789012:assumed-role/platform-observer/install-observer"]
  }

  expect_failures = [var.system_observer_role_arns]
}

run "rejects_a_role_arn_with_a_trailing_slash" {
  command = plan

  variables {
    system_observer_role_arns = ["arn:aws:iam::123456789012:role/platform-observer/"]
  }

  expect_failures = [var.system_observer_role_arns]
}
