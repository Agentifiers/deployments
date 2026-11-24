# The real AWS provider renders policy documents offline with fake credentials, so the test
# asserts the JSON IAM receives.
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

run "directory_provisioning_reaches_only_principal_and_fence_partitions" {
  command = plan

  assert {
    condition = jsondecode(data.aws_iam_policy_document.directory_provisioning.json).Statement == [{
      Sid    = "ProvisionDirectoryPrincipals"
      Effect = "Allow"
      Action = [
        "dynamodb:TransactWriteItems",
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:ConditionCheckItem",
      ]
      Resource = "arn:aws:dynamodb:us-east-2:123456789012:table/identity"
      Condition = {
        "ForAllValues:StringLike" = {
          "dynamodb:LeadingKeys" = ["PRINCIPAL#*", "BFF-IDENTITY-FENCE#*"]
        }
      }
    }]
    error_message = "The API role may read and create identity-table items only in principal and BFF fence partitions."
  }
}
