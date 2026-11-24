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

run "unconfigured_install_has_no_challenge" {
  command = plan

  variables {
    human_verification = null
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION")
    error_message = "Without human_verification the identity API must not receive a challenge configuration."
  }

  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.api.policy).Statement : statement if contains(statement.Action, "ssm:GetParameter")]) == 0
    error_message = "Without human_verification the identity API must not read any SSM parameter."
  }
}

run "configured_install_reads_the_named_secret" {
  command = plan

  variables {
    human_verification = {
      response_field        = "challenge-response"
      script_url            = "https://challenge.example/v1/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "site-key-1"
      verify_url            = "https://challenge.example/v1/siteverify"
      widget_class          = "challenge"
    }
  }

  assert {
    condition = jsondecode(aws_lambda_function.api.environment[0].variables["DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION"]) == {
      responseField      = "challenge-response"
      scriptUrl          = "https://challenge.example/v1/api.js"
      secretParameterArn = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/human-verification-secret"
      siteKey            = "site-key-1"
      verifyUrl          = "https://challenge.example/v1/siteverify"
      widgetClass        = "challenge"
      widgetOrigins      = []
    }
    error_message = "The identity API must receive the challenge configuration with the secret's parameter ARN."
  }

  assert {
    condition = [for statement in jsondecode(aws_iam_role_policy.api.policy).Statement : statement if contains(statement.Action, "ssm:GetParameter")] == [{
      Action   = ["ssm:GetParameter"]
      Effect   = "Allow"
      Resource = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/human-verification-secret"
    }]
    error_message = "The identity API must read exactly the named human verification secret."
  }
}

run "accepts_the_documented_turnstile_example" {
  command = plan

  assert {
    condition = jsondecode(aws_lambda_function.api.environment[0].variables["DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION"]) == {
      responseField      = "cf-turnstile-response"
      scriptUrl          = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secretParameterArn = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/human-verification-secret"
      siteKey            = "0x4AAAAAAABkMYinukE8nzY"
      verifyUrl          = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widgetClass        = "cf-turnstile"
      widgetOrigins      = []
    }
    error_message = "The documented Turnstile example must reach the identity API unchanged."
  }
}

run "accepts_the_documented_hcaptcha_example" {
  command = plan

  variables {
    human_verification = {
      response_field        = "h-captcha-response"
      script_url            = "https://js.hcaptcha.com/1/api.js"
      secret_parameter_name = "identity/hcaptcha-secret"
      site_key              = "10000000-ffff-ffff-ffff-000000000001"
      verify_url            = "https://api.hcaptcha.com/siteverify"
      widget_class          = "h-captcha"
      widget_origins        = ["https://hcaptcha.com", "https://*.hcaptcha.com"]
    }
  }

  assert {
    condition = jsondecode(aws_lambda_function.api.environment[0].variables["DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION"]) == {
      responseField      = "h-captcha-response"
      scriptUrl          = "https://js.hcaptcha.com/1/api.js"
      secretParameterArn = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/hcaptcha-secret"
      siteKey            = "10000000-ffff-ffff-ffff-000000000001"
      verifyUrl          = "https://api.hcaptcha.com/siteverify"
      widgetClass        = "h-captcha"
      widgetOrigins      = ["https://hcaptcha.com", "https://*.hcaptcha.com"]
    }
    error_message = "The documented hCaptcha example must reach the identity API unchanged."
  }
}

run "rejects_an_insecure_widget_script" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "http://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_verify_url_with_credentials" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://user:pass@challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_verify_url_port_out_of_range" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com:65536/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_script_host_the_url_parser_cannot_decode" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://xn--zz.example/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_script_host_read_as_an_ip_address" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.999/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_missing_verify_url" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = null
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_secret_given_as_an_arn" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_site_key_over_256_characters" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = join("", [for _ in range(257) : "k"])
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_widget_class_over_64_characters" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = join("", [for _ in range(65) : "c"])
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_response_field_that_breaks_out_of_its_attribute" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response\" autofocus=\""
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_widget_origin_port_over_5_digits" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
      widget_origins        = ["https://hcaptcha.com:123456"]
    }
  }

  expect_failures = [var.human_verification]
}

run "rejects_a_widget_origin_that_injects_a_csp_directive" {
  command = plan

  variables {
    human_verification = {
      response_field        = "cf-turnstile-response"
      script_url            = "https://challenges.cloudflare.com/turnstile/v0/api.js"
      secret_parameter_name = "/identity/human-verification-secret"
      site_key              = "0x4AAAAAAABkMYinukE8nzY"
      verify_url            = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      widget_class          = "cf-turnstile"
      widget_origins        = ["https://hcaptcha.com; script-src *"]
    }
  }

  expect_failures = [var.human_verification]
}
