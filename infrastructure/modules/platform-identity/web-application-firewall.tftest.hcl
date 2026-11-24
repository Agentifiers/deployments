# The real AWS provider plans offline with fake credentials, so resource attributes stay
# unknown at plan as on a first deploy and plan-time ARN validation sees no mock values.
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "test"
  secret_key                  = "test"
  max_retries                 = 1
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

variables {
  alarm_topic_arn                  = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  api_artifact_bucket              = "artifacts-123456789012"
  api_artifact_key                 = "identity-api.zip"
  api_artifact_version             = "version-1"
  application_origin               = "https://app.dev.platform.example"
  cli_redirect_uris                = ["http://127.0.0.1/callback"]
  control_table_arn                = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name               = "control"
  data_kms_key_arn                 = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  deletion_protection_enabled      = false
  deploying_role_name              = "platform-deploy"
  detailed_metrics_enabled         = false
  domain_name                      = "auth.dev.platform.example"
  email_artifact_bucket            = "artifacts-123456789012"
  email_artifact_key               = "identity-email.zip"
  email_artifact_version           = "version-1"
  email_sender                     = "no-reply@auth.dev.platform.example"
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
  resource_audience                = "https://api.dev.platform.example"
  web_application_firewall_enabled = true
  web_redirect_uris                = ["https://app.dev.platform.example/auth/callback"]
}

run "oversized_bodies_are_blocked_everywhere_but_the_saml_acs" {
  command = plan

  assert {
    condition = [
      for rule in aws_wafv2_web_acl.identity[0].rule : [
        for override in rule.statement[0].managed_rule_group_statement[0].rule_action_override : {
          name  = override.name
          count = length(override.action_to_use[0].count)
        }
      ] if rule.name == "aws-managed-common"
    ] == [[{ name = "SizeRestrictions_BODY", count = 1 }]]
    error_message = "The managed common rule set must only count, not block, oversized bodies; every other managed rule keeps its action."
  }

  assert {
    condition = [
      for rule in aws_wafv2_web_acl.identity[0].rule : {
        priority = rule.priority
        blocks   = length(rule.action[0].block)
        label    = rule.statement[0].and_statement[0].statement[0].label_match_statement[0].key
        excluded = rule.statement[0].and_statement[0].statement[1].not_statement[0].statement[0].regex_match_statement[0].regex_string
        uri_path = length(rule.statement[0].and_statement[0].statement[1].not_statement[0].statement[0].regex_match_statement[0].field_to_match[0].uri_path)
      } if rule.name == "body-size-outside-saml-acs"
      ] == [{
        priority = 2
        blocks   = 1
        label    = "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
        excluded = "^/saml/[0-9A-HJKMNP-TV-Z]{26}/acs$"
        uri_path = 1
    }]
    error_message = "A rule after the managed group must block requests the managed group labelled oversized unless the URI path is a SAML ACS."
  }

  assert {
    condition = { for rule in aws_wafv2_web_acl.identity[0].rule : rule.name => rule.priority } == {
      "aws-managed-common"         = 1
      "body-size-outside-saml-acs" = 2
      "coarse-ip-rate-limit"       = 3
    }
    error_message = "The body-size rule must run after the managed group that labels requests and before the rate limit."
  }

  assert {
    condition = [
      for rule in aws_wafv2_web_acl.identity[0].rule : [
        for path in [
          "/saml/01HZY3K5V7W9XAB2CD4EF6GH8J/acs",
          "/saml/01HZY3K5V7W9XAB2CD4EF6GH8J/acs/",
          "/saml/01HZY3K5V7W9XAB2CD4EF6GH8I/acs",
          "/saml/01hzy3k5v7w9xab2cd4ef6gh8j/acs",
          "/saml/01HZY3K5V7W9XAB2CD4EF6GH8J/metadata",
          "/v1/saml/01HZY3K5V7W9XAB2CD4EF6GH8J/acs",
          "/oauth2/token",
        ] : can(regex(rule.statement[0].and_statement[0].statement[1].not_statement[0].statement[0].regex_match_statement[0].regex_string, path))
      ] if rule.name == "body-size-outside-saml-acs"
    ] == [[true, false, false, false, false, false, false]]
    error_message = "The ACS exemption must match only /saml/<uppercase Crockford ULID>/acs."
  }
}
