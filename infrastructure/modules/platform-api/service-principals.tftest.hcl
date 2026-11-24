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

run "service_route_requires_iam_and_reaches_the_system_lambda" {
  command = plan

  variables {
    default_model_spend_ceiling_usd_micros = 5000000
    system_service_principals = {
      billing = {
        role_arn = "arn:aws:iam::123456789012:role/hosted/billing-service"
        grants   = ["organization-read", "organization-holds", "organization-entitlements"]
      }
      abuse-desk = {
        role_arn = "arn:aws:iam::123456789012:role/abuse-desk"
        grants   = ["organization-read", "organization-holds"]
      }
    }
  }

  assert {
    condition = [for route in aws_apigatewayv2_route.system_service : [route.route_key, route.authorization_type]] == [
      ["ANY /v1/system/services/{proxy+}", "AWS_IAM"],
    ]
    error_message = "Machine services must reach the system API through one ANY /v1/system/services/{proxy+} route that requires SigV4."
  }

  assert {
    condition = jsondecode(aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS"]) == {
      abuse-desk = {
        grants   = ["organization-holds", "organization-read"]
        role_arn = "arn:aws:iam::123456789012:role/abuse-desk"
      }
      billing = {
        grants   = ["organization-entitlements", "organization-holds", "organization-read"]
        role_arn = "arn:aws:iam::123456789012:role/hosted/billing-service"
      }
    }
    error_message = "The system Lambda must receive every service principal with its role and grants as JSON."
  }

  assert {
    condition = [
      aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_AWS_ACCOUNT_ID"],
      aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS"],
    ] == ["123456789012", "5000000"]
    error_message = "The system Lambda must receive its own account ID and the default operator-funded model spend ceiling."
  }

  assert {
    condition = alltrue([
      for function in aws_lambda_function.api :
      lookup(function.environment[0].variables, "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS", null) == "5000000"
    ])
    error_message = "Every API function gates on organization standing, so each must receive the default operator-funded model spend ceiling."
  }

  assert {
    condition = !contains(
      keys(aws_lambda_function.api["governance"].environment[0].variables),
      "DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS",
    )
    error_message = "Only the functions that bundle the system API receive the service principals."
  }
}

run "default_adds_no_service_route_or_configuration" {
  command = plan

  assert {
    condition     = length(aws_apigatewayv2_route.system_service) == 0
    error_message = "An install with no service principals must add no service route."
  }

  assert {
    condition = length(setintersection(
      keys(aws_lambda_function.api["system"].environment[0].variables),
      [
        "DEPLOYMENTS_AI_AWS_ACCOUNT_ID",
        "DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS",
      ],
    )) == 0
    error_message = "No service configuration reaches the system Lambda by default."
  }

  assert {
    condition = alltrue([
      for function in aws_lambda_function.api :
      !contains(keys(function.environment[0].variables), "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS")
    ])
    error_message = "No API function receives a ceiling by default, so organizations keep unlimited operator-funded model spend."
  }
}

run "rejects_a_service_role_in_another_account" {
  command = plan

  variables {
    system_service_principals = {
      billing = {
        role_arn = "arn:aws:iam::210987654321:role/billing-service"
        grants   = ["organization-read"]
      }
    }
  }

  expect_failures = [var.system_service_principals]
}

run "rejects_two_services_holding_organization_entitlements" {
  command = plan

  variables {
    system_service_principals = {
      billing = {
        role_arn = "arn:aws:iam::123456789012:role/billing-service"
        grants   = ["organization-entitlements"]
      }
      reseller = {
        role_arn = "arn:aws:iam::123456789012:role/reseller"
        grants   = ["organization-entitlements"]
      }
    }
  }

  expect_failures = [var.system_service_principals]
}

run "rejects_two_services_sharing_a_role" {
  command = plan

  variables {
    system_service_principals = {
      billing = {
        role_arn = "arn:aws:iam::123456789012:role/billing-service"
        grants   = ["organization-read"]
      }
      mirror = {
        role_arn = "arn:aws:iam::123456789012:role/other/billing-service"
        grants   = ["organization-read"]
      }
    }
  }

  expect_failures = [var.system_service_principals]
}

run "rejects_an_unknown_grant" {
  command = plan

  variables {
    system_service_principals = {
      billing = {
        role_arn = "arn:aws:iam::123456789012:role/billing-service"
        grants   = ["organization-delete"]
      }
    }
  }

  expect_failures = [var.system_service_principals]
}

run "rejects_a_service_name_that_is_not_a_slug" {
  command = plan

  variables {
    system_service_principals = {
      Billing = {
        role_arn = "arn:aws:iam::123456789012:role/billing-service"
        grants   = ["organization-read"]
      }
    }
  }

  expect_failures = [var.system_service_principals]
}

run "rejects_a_fractional_default_ceiling" {
  command = plan

  variables {
    default_model_spend_ceiling_usd_micros = 0.5
  }

  expect_failures = [var.default_model_spend_ceiling_usd_micros]
}
