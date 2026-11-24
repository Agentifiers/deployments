mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-2:123456789012:ops-alerts" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/ops-alerts-notifier" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-2:123456789012:ops-alerts-notifier-failures" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:ops-alerts-notifier" }
  }
}

variables {
  alert_email               = ""
  environment               = "acme"
  kms_key_arn               = "arn:aws:kms:us-east-2:123456789012:key/00000000-0000-0000-0000-000000000000"
  log_retention_in_days     = 14
  notifier_artifact_bucket  = "artifacts"
  notifier_artifact_key     = "ops-alerts-notifier.zip"
  notifier_artifact_version = "v1"
  slack_channel_id          = ""
}

run "no_alarms_without_a_destination" {
  command = plan

  assert {
    condition     = output.connected == false && aws_cloudwatch_metric_alarm.notifier_errors == null
    error_message = "With no email and no Slack channel, the ops alerts topic reaches no one, so no alarm may be created."
  }
}

run "slack_connects_alarms" {
  command = plan

  variables {
    slack_channel_id = "C0123456789"
  }

  assert {
    condition     = output.connected && aws_cloudwatch_metric_alarm.notifier_errors != null
    error_message = "A Slack channel connects the topic, so its alarms must be created."
  }
}

run "email_connects_alarms" {
  command = plan

  variables {
    alert_email = "ops@example.com"
  }

  assert {
    condition     = output.connected && aws_cloudwatch_metric_alarm.notifier_failures != null
    error_message = "An email subscription connects the topic, so its alarms must be created."
  }
}
