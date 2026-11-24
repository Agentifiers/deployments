resource "aws_lambda_function" "event_dispatcher" {
  function_name = "event-dispatcher"
  description   = "Publishes committed local semantic event outbox records from DynamoDB Streams."
  architectures = ["x86_64"]
  filename      = "${path.module}/../../../dist/functions/event-dispatcher-local.zip"
  source_code_hash = try(
    filebase64sha256("${path.module}/../../../dist/functions/event-dispatcher-local.zip"),
    null
  )
  handler     = "index.handler"
  memory_size = 256
  role        = "arn:aws:iam::000000000000:role/event-dispatcher"
  runtime     = "nodejs26.x"
  timeout     = 30

  environment {
    variables = {
      AWS_ENDPOINT_URL_EVENTBRIDGE  = var.aws_endpoint_url
      AWS_ENDPOINT_URL_EVENTS       = var.aws_endpoint_url
      DEPLOYMENTS_AI_EVENT_BUS_NAME = aws_cloudwatch_event_bus.semantic.name
    }
  }
}

resource "aws_lambda_event_source_mapping" "event_dispatcher" {
  event_source_arn                   = aws_dynamodb_table.platform["events"].stream_arn
  function_name                      = aws_lambda_function.event_dispatcher.arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  bisect_batch_on_function_error     = true
  maximum_record_age_in_seconds      = 75600
  maximum_retry_attempts             = 10
  function_response_types            = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb = {
          NewImage = {
            itemType = {
              S = ["semantic-event"]
            }
          }
        }
      })
    }
  }
}
