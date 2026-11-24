resource "aws_apigatewayv2_api" "runtime" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"
  tags          = local.common_tags
}

resource "aws_apigatewayv2_integration" "runtime" {
  api_id                 = aws_apigatewayv2_api.runtime.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "runtime" {
  for_each = local.runtime_api_routes

  api_id             = aws_apigatewayv2_api.runtime.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.runtime.id}"
}

resource "aws_apigatewayv2_stage" "runtime" {
  api_id      = aws_apigatewayv2_api.runtime.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttling_burst_limit
    throttling_rate_limit  = var.api_throttling_rate_limit
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowRuntimeHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.runtime.execution_arn}/*/*"
}

resource "aws_lambda_event_source_mapping" "usage" {
  event_source_arn = var.usage_table_stream_arn
  function_name    = aws_lambda_function.usage.arn
  # Agent runtime is the first producer of meter events in this port; TRIM_HORIZON
  # covers the deployment window between enabling the stream and attaching this consumer.
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 100
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  maximum_retry_attempts         = 10

  metrics_config {
    metrics = ["EventCount"]
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.usage_failures.arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "artifact_retention" {
  event_source_arn  = var.execution_table_stream_arn
  function_name     = aws_lambda_function.artifact_retention.arn
  starting_position = "TRIM_HORIZON"

  batch_size                     = 100
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  maximum_retry_attempts         = 10

  metrics_config {
    metrics = ["EventCount"]
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
        dynamodb = {
          OldImage = {
            itemType = { S = ["artifact"] }
          }
        }
      })
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.artifact_retention_failures.arn
    }
  }
}
resource "aws_lambda_event_source_mapping" "trace_finalization" {
  event_source_arn  = var.execution_table_stream_arn
  function_name     = aws_lambda_function.trace_finalization.arn
  starting_position = "TRIM_HORIZON"

  batch_size                     = 100
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  maximum_retry_attempts         = 10

  metrics_config {
    metrics = ["EventCount"]
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb = {
          NewImage = {
            itemType = { S = ["run"] }
            data = {
              M = {
                status = { S = ["canceled", "completed", "failed"] }
              }
            }
          }
        }
      })
    }
    filter {
      pattern = jsonencode({
        eventName = ["MODIFY"]
        dynamodb = {
          NewImage = {
            itemType = { S = ["provider-mutation-claim"] }
            data = {
              M = {
                status = { S = ["failed", "reconciled", "releasable", "succeeded"] }
              }
            }
          }
        }
      })
    }
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
        dynamodb = {
          OldImage = {
            itemType = { S = ["provider-mutation-claim"] }
            data = {
              M = {
                status = { S = ["active", "unknown"] }
              }
            }
          }
        }
      })
    }
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb = {
          NewImage = {
            itemType = { S = ["memory-flush"] }
            data = {
              M = {
                status = { S = ["failed", "queued", "running", "succeeded"] }
              }
            }
          }
        }
      })
    }
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb = {
          NewImage = {
            itemType = { S = ["trace"] }
            data = {
              M = {
                status = { S = ["finalized"] }
              }
            }
          }
        }
      })
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.trace_finalization_failures.arn
    }
  }
}
