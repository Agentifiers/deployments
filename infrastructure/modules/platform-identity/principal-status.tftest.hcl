mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-2" }
  }
  mock_resource "aws_api_gateway_rest_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-2:123456789012:mockapi" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-2:123456789012:rule/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:123456789012:log-group:mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-2:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-2:123456789012:mock"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/mock"
    }
  }
}

variables {
  alarm_topic_arn                  = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  api_artifact_bucket              = "artifacts-123456789012"
  api_artifact_key                 = "identity-api.zip"
  api_artifact_version             = "version-1"
  application_origin               = "https://app.platform.example"
  cli_redirect_uris                = ["http://127.0.0.1/callback"]
  control_table_arn                = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name               = "control"
  data_kms_key_arn                 = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  deletion_protection_enabled      = false
  deploying_role_name              = "deployer"
  detailed_metrics_enabled         = false
  domain_name                      = "auth.platform.example"
  email_artifact_bucket            = "artifacts-123456789012"
  email_artifact_key               = "identity-email.zip"
  email_artifact_version           = "version-1"
  email_sender                     = "identity@platform.example"
  e2e_client_enabled               = false
  environment                      = "dev"
  events_table_arn                 = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
  events_table_name                = "events"
  identity_email_stream_arn        = "arn:aws:dynamodb:us-east-2:123456789012:table/identity-email-outbox/stream/2026-01-01T00:00:00.000"
  identity_email_table_arn         = "arn:aws:dynamodb:us-east-2:123456789012:table/identity-email-outbox"
  identity_email_table_name        = "identity-email-outbox"
  identity_table_arn               = "arn:aws:dynamodb:us-east-2:123456789012:table/identity"
  identity_table_name              = "identity"
  kms_deletion_window_in_days      = 7
  log_retention_in_days            = 30
  resource_audience                = "https://api.platform.example"
  web_application_firewall_enabled = false
  web_redirect_uris                = ["https://app.platform.example/auth/callback"]
  human_verification = {
    response_field        = "cf-turnstile-response"
    script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
    secret_parameter_name = "/identity/human-verification-secret"
    site_key              = "0x4AAAAAAABkMYinukE8nzY"
    verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    widget_class          = "cf-turnstile"
  }
}

run "principal_status_queries_only_the_identity_index_it_reads" {
  command = plan

  assert {
    condition = [for statement in jsondecode(aws_iam_role_policy.principal_status.policy).Statement : statement.Resource if contains(statement.Action, "dynamodb:Query")] == [
      ["arn:aws:dynamodb:us-east-2:123456789012:table/identity/index/gsi1"],
    ]
    error_message = "The principal status function may query only the identity table's gsi1, where it lists sessions and refresh token families."
  }
}
