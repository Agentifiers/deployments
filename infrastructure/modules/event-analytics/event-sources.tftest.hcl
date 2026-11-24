# The real AWS provider plans offline with fake credentials, so computed ARNs stay unknown
# instead of failing the provider's plan-time ARN validation.
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

override_data {
  target = data.aws_region.current
  values = { region = "us-east-2" }
}

variables {
  alarm_topic_arn                     = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  environment                         = "dev"
  event_bus_name                      = "semantic-events"
  failure_retention_in_days           = 30
  log_retention_in_days               = 30
  projector_artifact_bucket           = "artifacts-123456789012"
  projector_artifact_key              = "event-analytics-projector.zip"
  projector_artifact_version          = "v1"
  query_result_retention_in_days      = 7
  s3_table_arn                        = "arn:aws:s3tables:us-east-2:123456789012:bucket/semantic-events/table/events"
  s3_table_bucket_arn                 = "arn:aws:s3tables:us-east-2:123456789012:bucket/semantic-events"
  s3_table_bucket_name                = "semantic-events"
  s3_table_name                       = "events"
  s3_table_namespace                  = "semantic_events"
  s3tables_catalog_arn                = "arn:aws:glue:us-east-2:123456789012:catalog/s3tablescatalog"
  s3tables_catalog_name               = "s3tablescatalog"
  storage_deletion_protection_enabled = true
}

run "records_only_platform_events_by_default" {
  command = plan

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.projector.event_pattern).source == ["deployments-ai.platform"]
    error_message = "Without extra sources the rule must match only platform events."
  }
}

run "records_extra_sources_alongside_the_platform" {
  command = plan

  variables {
    extra_event_sources = ["acme.orders", "deployments-ai.platform"]
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.projector.event_pattern).source == ["deployments-ai.platform", "acme.orders"]
    error_message = "Extra sources must add to the platform source, never replace or repeat it."
  }
}

run "rejects_an_empty_source" {
  command = plan

  variables {
    extra_event_sources = [" "]
  }

  expect_failures = [var.extra_event_sources]
}
