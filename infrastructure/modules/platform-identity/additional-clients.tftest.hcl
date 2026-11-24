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
}

run "declared_client_names_its_secret_parameter" {
  command = plan

  variables {
    additional_clients = {
      "operator-tools" = {
        allowed_scopes = ["email", "openid", "profile"]
        name           = "Operator tools"
        redirect_uris  = ["https://tools.platform.example/auth/callback"]
      }
    }
  }

  assert {
    condition = (
      keys(output.client_bootstrap.additional_clients) == ["operator-tools"] &&
      output.client_bootstrap.additional_clients["operator-tools"].secret_arn == "arn:aws:ssm:us-east-2:123456789012:parameter/identity/operator-tools-oauth-client" &&
      output.client_bootstrap.additional_clients["operator-tools"].name == "Operator tools" &&
      tolist(output.client_bootstrap.additional_clients["operator-tools"].allowed_scopes) == tolist(["email", "openid", "profile"]) &&
      tolist(output.client_bootstrap.additional_clients["operator-tools"].redirect_uris) == tolist(["https://tools.platform.example/auth/callback"])
    )
    error_message = "A declared client must reach the bootstrap with its secret parameter under /identity/<client ID>-oauth-client."
  }
}

run "no_declared_clients_by_default" {
  command = plan

  assert {
    condition     = length(output.client_bootstrap.additional_clients) == 0
    error_message = "Without declared clients the bootstrap must receive an empty map."
  }
}

run "rejects_a_built_in_client_id" {
  command = plan

  variables {
    additional_clients = {
      "deployments-web" = {
        allowed_scopes = ["openid"]
        name           = "Impostor"
        redirect_uris  = ["https://tools.platform.example/auth/callback"]
      }
    }
  }

  expect_failures = [var.additional_clients]
}

run "rejects_an_id_that_names_a_built_in_secret_parameter" {
  command = plan

  variables {
    additional_clients = {
      web = {
        allowed_scopes = ["openid"]
        name           = "Impostor"
        redirect_uris  = ["https://tools.platform.example/auth/callback"]
      }
    }
  }

  expect_failures = [var.additional_clients]
}

run "rejects_an_insecure_redirect_uri" {
  command = plan

  variables {
    additional_clients = {
      "operator-tools" = {
        allowed_scopes = ["openid"]
        name           = "Operator tools"
        redirect_uris  = ["http://tools.platform.example/auth/callback"]
      }
    }
  }

  expect_failures = [var.additional_clients]
}

run "rejects_a_client_without_openid" {
  command = plan

  variables {
    additional_clients = {
      "operator-tools" = {
        allowed_scopes = ["email"]
        name           = "Operator tools"
        redirect_uris  = ["https://tools.platform.example/auth/callback"]
      }
    }
  }

  expect_failures = [var.additional_clients]
}
