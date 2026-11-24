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

run "activates_default_search_for_every_new_organization" {
  command = plan

  variables {
    alarm_topic_arn            = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
    artifact_bucket            = "artifacts-123456789012"
    artifact_key               = "memory-runtime.zip"
    artifact_version           = "version-1"
    blob_bucket_arn            = "arn:aws:s3:::artifacts-123456789012"
    blob_bucket_name           = "artifacts-123456789012"
    data_kms_key_arn           = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
    environment                = "dev"
    event_bus_name             = "semantic-events"
    jwt_audience               = ["memory"]
    jwt_issuer                 = "https://identity.example.com"
    log_retention_in_days      = 30
    model_gateway_base_url     = "http://model-gateway.internal"
    model_gateway_fallback_ids = []
    model_gateway_token_issuer = {
      arn           = "arn:aws:lambda:us-east-2:123456789012:function:agent-runtime-model-token-memory"
      function_name = "agent-runtime-model-token-memory"
    }
    opensearch_domain_arn        = "arn:aws:es:us-east-2:123456789012:domain/search"
    opensearch_endpoint          = "https://vpc-search-abc123.us-east-2.es.amazonaws.com"
    reconciliation_scopes        = []
    request_admission_table_arn  = "arn:aws:dynamodb:us-east-2:123456789012:table/request-admission"
    request_admission_table_name = "request-admission"
    tenant_limit_defaults_json   = "{}"
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

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.queue["memory-search-placement"].event_pattern)["detail-type"] == ["organization.created"]
    error_message = "Every organization.created event must reach the default search placement worker."
  }

  assert {
    condition     = aws_lambda_function.runtime["memory-search-placement"].handler == "search-placement-worker.handler"
    error_message = "The default search placement worker must run its entry point."
  }
}
