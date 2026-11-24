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

run "runtime_policy_covers_every_brain_runtime" {
  command = plan

  override_resource {
    target = aws_sqs_queue.index
    values = {
      arn = "arn:aws:sqs:us-east-2:123456789012:brain-index.fifo"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/brain-index.fifo"
    }
  }

  variables {
    alarm_topic_arn            = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
    artifact_bucket            = "artifacts-123456789012"
    artifact_key               = "platform-api.zip"
    artifact_version           = "version-1"
    model_gateway_base_url     = "http://model-gateway.internal"
    model_gateway_fallback_ids = []
    model_gateway_token_issuer = {
      arn           = "arn:aws:lambda:us-east-2:123456789012:function:agent-runtime-model-token-brain"
      function_name = "agent-runtime-model-token-brain"
    }
    content_bucket_arn           = "arn:aws:s3:::artifacts-123456789012"
    content_bucket_name          = "artifacts-123456789012"
    data_kms_key_arn             = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
    document_extraction_function = { arn = "arn:aws:lambda:us-east-2:123456789012:function:document-extraction", function_name = "document-extraction" }
    environment                  = "dev"
    event_bus_name               = "semantic-events"
    log_retention_in_days        = 30
    memory_erasure_function_arn  = "arn:aws:lambda:us-east-2:123456789012:function:memory-erasure"
    memory_erasure_function_name = "memory-erasure"
    opensearch_domain_arn        = "arn:aws:es:us-east-2:123456789012:domain/search"
    opensearch_endpoint          = "https://vpc-search-abc123.us-east-2.es.amazonaws.com"
    private_subnet_ids           = ["subnet-00000000000000001"]
    vpc_id                       = "vpc-00000000000000001"
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
    condition     = contains(local.runtime_names, "brain-index-dispatch")
    error_message = "Brain index dispatch must remain part of the runtime policy set."
  }

  assert {
    condition = length(setsubtract(local.runtime_names, toset([
      "brain-content-maintenance",
      "brain-erasure-worker",
      "brain-index-dispatch",
      "brain-index-worker",
      "brain-search-erasure",
      "brain-search-placement",
    ]))) == 0 && length(local.runtime_names) == 6
    error_message = "Every Brain table reader must be covered by the shared runtime policy document."
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.search_placement.event_pattern)["detail-type"] == ["memory.search-placement.activated"]
    error_message = "Default Brain search activation must follow memory search activation."
  }

  assert {
    condition     = aws_lambda_function.search_placement.handler == "brain-search-placement-main.handler"
    error_message = "The Brain search placement Lambda must run the placement entry point."
  }

  assert {
    condition     = aws_lambda_function.worker.environment[0].variables["DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL"] == "https://sqs.us-east-2.amazonaws.com/123456789012/brain-index.fifo"
    error_message = "The Brain index worker must know its queue URL to delay a failed message until its retry is due."
  }
}
