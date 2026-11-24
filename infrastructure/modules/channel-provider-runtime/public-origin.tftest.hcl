mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://abc123.execute-api.us-east-2.amazonaws.com"
      execution_arn = "arn:aws:execute-api:us-east-2:123456789012:abc123"
    }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-east-2:123456789012:certificate/33333333-3333-3333-3333-333333333333" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:123456789012:log-group:/aws/lambda/channel" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/channel" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/channel" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-2:123456789012:function:channel"
      invoke_arn = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:channel/invocations"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-2:123456789012:channel"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/channel"
    }
  }
}

variables {
  alarm_topic_arn       = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  artifact_bucket       = "artifacts-123456789012"
  artifact_key          = "channel-provider-runtime.zip"
  artifact_version      = "v1"
  control_table_arn     = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name    = "control"
  data_kms_key_arn      = "arn:aws:kms:us-east-2:123456789012:key/11111111-1111-1111-1111-111111111111"
  environment           = "test"
  event_bus_arn         = "arn:aws:events:us-east-2:123456789012:event-bus/platform"
  event_bus_name        = "platform"
  events_table_arn      = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
  events_table_name     = "events"
  execution_table_arn   = "arn:aws:dynamodb:us-east-2:123456789012:table/execution"
  execution_table_name  = "execution"
  jwt_audience          = ["platform-api"]
  jwt_issuer            = "https://identity.example.com"
  log_retention_in_days = 30
  oauth_apps_json       = "{}"
}

run "a_custom_domain_is_the_public_origin" {
  command = apply

  variables {
    domain_name     = "Channels.Example.com"
    route53_zone_id = "Z0EXAMPLE"
  }

  assert {
    condition     = output.oauth_public_origin == "https://channels.example.com"
    error_message = "The console and platform API must get the custom domain as the channel origin."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.oauth_api.environment[0].variables.PLATFORM_OAUTH_PUBLIC_ORIGIN == "https://channels.example.com",
      aws_lambda_function.oauth_refresh.environment[0].variables.PLATFORM_OAUTH_PUBLIC_ORIGIN == "https://channels.example.com",
    ])
    error_message = "OAuth callbacks and the client metadata document must use the custom domain."
  }

  assert {
    condition     = aws_apigatewayv2_api_mapping.public[0].stage == aws_apigatewayv2_stage.public.id
    error_message = "The custom domain must map to the API's default stage."
  }

  assert {
    condition     = toset(keys(aws_route53_record.public)) == toset(["A", "AAAA"])
    error_message = "The custom domain needs IPv4 and IPv6 alias records."
  }
}

run "without_a_domain_the_execute_api_endpoint_is_the_public_origin" {
  command = apply

  assert {
    condition     = output.oauth_public_origin == "https://abc123.execute-api.us-east-2.amazonaws.com"
    error_message = "An install without a channel domain keeps the execute-api origin."
  }

  assert {
    condition     = length(aws_apigatewayv2_domain_name.public) == 0 && length(aws_acm_certificate.public) == 0
    error_message = "No certificate or custom domain is created without a domain name."
  }
}

run "a_domain_needs_its_zone" {
  command = plan

  variables {
    domain_name = "channels.example.com"
  }

  expect_failures = [var.route53_zone_id]
}
