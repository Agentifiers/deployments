mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-2:123456789012:console" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:123456789012:log-group:/aws/lambda/console" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/console" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:console" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

variables {
  alarm_topic_arn             = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  application_origin          = "https://console.example.com"
  artifact_bucket             = "console-artifacts"
  artifact_key                = "console/server.zip"
  artifact_version            = "v1"
  certificate_arn             = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
  data_kms_key_arn            = "arn:aws:kms:us-east-2:123456789012:key/11111111-1111-1111-1111-111111111111"
  deletion_protection_enabled = true
  detailed_metrics_enabled    = false
  environment                 = "test"
  identity_issuer             = "https://identity.example.com"
  identity_table_arn          = "arn:aws:dynamodb:us-east-2:123456789012:table/identity"
  identity_table_name         = "identity"
  log_retention_in_days       = 30
  platform_api_url            = "https://api.example.com"
  web_client_secret_arn       = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client"
  web_redirect_uris           = ["https://console.example.com/auth/callback"]
}

run "defaults_keep_only_module_environment_and_policy" {
  command = plan

  assert {
    condition = aws_lambda_function.console.environment[0].variables == tomap({
      CONSOLE_IDENTITY_ISSUER       = "https://identity.example.com"
      CONSOLE_IDENTITY_TABLE_NAME   = "identity"
      CONSOLE_PLATFORM_API_URL      = "https://api.example.com"
      CONSOLE_PUBLIC_ORIGIN         = "https://console.example.com"
      CONSOLE_SESSION_KMS_KEY_ARN   = "arn:aws:kms:us-east-2:123456789012:key/11111111-1111-1111-1111-111111111111"
      CONSOLE_WEB_CLIENT_SECRET_ARN = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client"
    })
    error_message = "Without additional inputs the console Lambda must receive exactly the module's own environment."
  }

  assert {
    condition     = length(aws_iam_role_policy.console_additional) == 0
    error_message = "Without additional_policy_json the console role must carry no additional policy."
  }
}

run "refuses_module_owned_environment_keys" {
  command = plan

  variables {
    additional_environment = { CONSOLE_PUBLIC_ORIGIN = "https://evil.example" }
  }

  expect_failures = [var.additional_environment]
}

run "refuses_policy_that_is_not_json" {
  command = plan

  variables {
    additional_policy_json = "Allow everything"
  }

  expect_failures = [var.additional_policy_json]
}

run "adds_install_environment_and_policy" {
  command = plan

  variables {
    additional_environment = { JOBS_QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123456789012/console-jobs" }
    additional_policy_json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sqs:SendMessage\",\"Resource\":\"arn:aws:sqs:us-east-2:123456789012:console-jobs\"}]}"
  }

  assert {
    condition     = aws_iam_role_policy.console_additional[0].policy == "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sqs:SendMessage\",\"Resource\":\"arn:aws:sqs:us-east-2:123456789012:console-jobs\"}]}"
    error_message = "The additional policy must be attached verbatim."
  }

  assert {
    condition     = aws_iam_role_policy.console_additional[0].name == "console-additional"
    error_message = "The additional policy must sit beside the module's own console policy under its own name."
  }

  assert {
    condition     = aws_lambda_function.console.environment[0].variables["JOBS_QUEUE_URL"] == "https://sqs.us-east-2.amazonaws.com/123456789012/console-jobs"
    error_message = "The console Lambda must receive the additional environment variable."
  }

  assert {
    condition     = aws_lambda_function.console.environment[0].variables["CONSOLE_PUBLIC_ORIGIN"] == "https://console.example.com"
    error_message = "Additional environment must leave the module's own keys unchanged."
  }
}

run "passes_optional_integration_origins" {
  command = plan

  variables {
    docs_origin        = "https://docs.example.com"
    stream_gateway_url = "https://streams.example.com"
  }

  assert {
    condition     = aws_lambda_function.console.environment[0].variables["CONSOLE_STREAM_GATEWAY_URL"] == "https://streams.example.com"
    error_message = "The console Lambda must receive the stream gateway origin."
  }

  assert {
    condition     = aws_lambda_function.console.environment[0].variables["CONSOLE_DOCS_ORIGIN"] == "https://docs.example.com"
    error_message = "The console Lambda must receive the docs origin."
  }
}

run "refuses_stream_gateway_url_with_a_path" {
  command = plan

  variables {
    stream_gateway_url = "https://streams.example.com/v1"
  }

  expect_failures = [var.stream_gateway_url]
}
