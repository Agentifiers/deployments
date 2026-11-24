locals {
  memory_worker_handlers = {
    memory-cleanup   = "cleanup-worker.handler"
    memory-flush     = "flush-worker.handler"
    memory-index     = "index-worker.handler"
    memory-operation = "operation-worker.handler"
    memory-reconcile = "reconcile.handler"
    memory-shadow    = "shadow-worker.handler"
    memory-usage     = "usage-worker.handler"
  }
  memory_model_gateway_environment = trimspace(var.memory_model_gateway_token_issuer) == "" ? {} : {
    DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL     = var.memory_model_gateway_base_url
    DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER = var.memory_model_gateway_token_issuer
  }
  memory_reconciliation_scope_map = {
    for scope in var.memory_reconciliation_scopes :
    "${scope.organization_id}-${scope.project_id}-${scope.environment_id}-${coalesce(scope.workspace_id, "environment")}" => scope
  }
  memory_api_routes = toset([
    "DELETE /v1/memory-space-grants/{grantId}",
    "DELETE /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory",
    "GET /v1/memory-space-grants",
    "GET /v1/memory-spaces",
    "GET /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory/flushes/{runId}",
    "GET /v1/memory/policies",
    "GET /v1/memory/quality",
    "GET /v1/memory/namespaces/readiness",
    "GET /v1/memory/review-items",
    "PATCH /v1/memory-space-grants/{grantId}",
    "POST /v1/memory-space-grants",
    "POST /v1/memory-spaces",
    "POST /v1/memory/active-recall",
    "POST /v1/memory/evidence/strategy-search",
    "POST /v1/memory/exports",
    "POST /v1/memory/flushes",
    "POST /v1/memory/imports",
    "POST /v1/memory/namespaces/prepare-full-text",
    "POST /v1/memory/policies",
    "POST /v1/memory/search",
    "POST /v1/memory/{memoryId}/archive",
    "POST /v1/memory/{memoryId}/delete",
    "POST /v1/memory/{memoryId}/restore",
    "POST /v1/memory/{memoryId}/review-items/{reviewId}",
    "POST /v1/memory/{memoryId}/retrievals/{retrievalId}/feedback",
    "PUT /v1/memory/policies",
  ])
}

resource "aws_lambda_function" "memory_worker" {
  for_each = local.memory_worker_handlers

  function_name = each.key
  description   = "Consumes the local ${each.key} queue."
  architectures = ["x86_64"]
  filename      = "${path.module}/../../../dist/functions/memory-runtime-local.zip"
  source_code_hash = try(
    filebase64sha256("${path.module}/../../../dist/functions/memory-runtime-local.zip"),
    null
  )
  handler     = each.value
  memory_size = each.key == "memory-flush" ? 1024 : 512
  role        = "arn:aws:iam::000000000000:role/${each.key}"
  runtime     = "nodejs26.x"
  timeout     = each.key == "memory-operation" ? 900 : contains(["memory-cleanup", "memory-flush", "memory-reconcile"], each.key) ? 300 : 120

  environment {
    variables = merge(local.memory_model_gateway_environment, {
      AWS_ENDPOINT_URL                            = var.aws_endpoint_url
      AWS_ENDPOINT_URL_DYNAMODB                   = var.aws_endpoint_url
      AWS_ENDPOINT_URL_S3                         = var.aws_endpoint_url
      AWS_ENDPOINT_URL_SECRETS_MANAGER            = var.aws_endpoint_url
      AWS_ENDPOINT_URL_SQS                        = var.aws_endpoint_url
      DEPLOYMENTS_AI_CONTROL_TABLE                = aws_dynamodb_table.platform["control"].name
      DEPLOYMENTS_AI_EVENTS_TABLE                 = aws_dynamodb_table.platform["events"].name
      DEPLOYMENTS_AI_EXECUTION_TABLE              = aws_dynamodb_table.platform["execution"].name
      DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE  = aws_dynamodb_table.platform["identity-email-outbox"].name
      DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET           = aws_s3_bucket.artifacts.id
      DEPLOYMENTS_AI_MEMORY_CURSOR_KEY_HEX        = local.memory_cursor_key_hex
      DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS  = "1536"
      DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN = aws_secretsmanager_secret.runtime["memory-membership-hmac-key"].arn
      DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL   = aws_sqs_queue.runtime["memory-operation"].url
      DEPLOYMENTS_AI_MEMORY_USAGE_QUEUE_URL       = aws_sqs_queue.runtime["memory-usage"].url
      DEPLOYMENTS_AI_STAGE                        = "local"
      DEPLOYMENTS_AI_USAGE_TABLE                  = aws_dynamodb_table.platform["usage"].name
    })
  }
}

resource "aws_lambda_event_source_mapping" "memory_worker" {
  for_each = local.memory_worker_handlers

  event_source_arn        = aws_sqs_queue.runtime[each.key].arn
  function_name           = aws_lambda_function.memory_worker[each.key].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function" "memory_operation_reconciler" {
  function_name = "memory-operation-reconcile"
  architectures = ["x86_64"]
  filename      = "${path.module}/../../../dist/functions/memory-runtime-local.zip"
  source_code_hash = try(
    filebase64sha256("${path.module}/../../../dist/functions/memory-runtime-local.zip"),
    null
  )
  handler = "operation-reconciler.handler"
  role    = "arn:aws:iam::000000000000:role/memory-operation-reconcile"
  runtime = "nodejs26.x"
  timeout = 300
  environment {
    variables = {
      AWS_ENDPOINT_URL                          = var.aws_endpoint_url
      AWS_ENDPOINT_URL_DYNAMODB                 = var.aws_endpoint_url
      AWS_ENDPOINT_URL_SQS                      = var.aws_endpoint_url
      DEPLOYMENTS_AI_CONTROL_TABLE              = aws_dynamodb_table.platform["control"].name
      DEPLOYMENTS_AI_EXECUTION_TABLE            = aws_dynamodb_table.platform["execution"].name
      DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL     = aws_sqs_queue.runtime["memory-index"].url
      DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL = aws_sqs_queue.runtime["memory-operation"].url
    }
  }
}

resource "aws_lambda_function" "memory_api" {
  function_name = "memory-api"
  description   = "Serves the local JWT-protected memory API."
  architectures = ["x86_64"]
  filename      = "${path.module}/../../../dist/functions/memory-runtime-local.zip"
  source_code_hash = try(
    filebase64sha256("${path.module}/../../../dist/functions/memory-runtime-local.zip"),
    null
  )
  handler     = "api.handler"
  memory_size = 512
  role        = "arn:aws:iam::000000000000:role/memory-api"
  runtime     = "nodejs26.x"
  timeout     = 30

  environment {
    variables = merge(local.memory_model_gateway_environment, {
      AWS_ENDPOINT_URL                           = var.aws_endpoint_url
      AWS_ENDPOINT_URL_DYNAMODB                  = var.aws_endpoint_url
      AWS_ENDPOINT_URL_S3                        = var.aws_endpoint_url
      AWS_ENDPOINT_URL_SECRETS_MANAGER           = var.aws_endpoint_url
      AWS_ENDPOINT_URL_SQS                       = var.aws_endpoint_url
      DEPLOYMENTS_AI_CONTROL_TABLE               = aws_dynamodb_table.platform["control"].name
      DEPLOYMENTS_AI_EVENTS_TABLE                = aws_dynamodb_table.platform["events"].name
      DEPLOYMENTS_AI_EXECUTION_TABLE             = aws_dynamodb_table.platform["execution"].name
      DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE = aws_dynamodb_table.platform["identity-email-outbox"].name
      DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET          = aws_s3_bucket.artifacts.id
      DEPLOYMENTS_AI_MEMORY_CURSOR_KEY_HEX       = local.memory_cursor_key_hex
      DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS = "1536"
      DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES        = jsonencode(var.memory_jwt_audience)
      DEPLOYMENTS_AI_MEMORY_JWT_ISSUER           = var.memory_jwt_issuer
      DEPLOYMENTS_AI_MEMORY_USAGE_QUEUE_URL      = aws_sqs_queue.runtime["memory-usage"].url
      DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE     = aws_dynamodb_table.request_admission.name
      DEPLOYMENTS_AI_STAGE                       = "local"
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS       = local.tenant_limit_defaults_json
      DEPLOYMENTS_AI_USAGE_TABLE                 = aws_dynamodb_table.platform["usage"].name
    })
  }
}

resource "aws_lambda_function" "identity_api" {
  function_name = "identity-api"
  description   = "Serves normalized local platform identity."
  architectures = ["x86_64"]
  filename      = "${path.module}/../../../dist/functions/platform-api-local.zip"
  source_code_hash = try(
    filebase64sha256("${path.module}/../../../dist/functions/platform-api-local.zip"),
    null
  )
  handler     = "lambda-main.handler"
  memory_size = 512
  role        = "arn:aws:iam::000000000000:role/identity-api"
  runtime     = "nodejs26.x"
  timeout     = 30

  environment {
    variables = {
      AWS_ENDPOINT_URL                           = var.aws_endpoint_url
      AWS_ENDPOINT_URL_DYNAMODB                  = var.aws_endpoint_url
      AWS_ENDPOINT_URL_KMS                       = var.aws_endpoint_url
      DEPLOYMENTS_AI_API_CURSOR_KEY_HEX          = local.memory_cursor_key_hex
      DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN = "arn:aws:kms:${var.aws_region}:000000000000:key/local-artifacts"
      DEPLOYMENTS_AI_API_JWT_AUDIENCE            = jsonencode(var.memory_jwt_audience)
      DEPLOYMENTS_AI_API_JWT_ISSUER              = var.memory_jwt_issuer
      DEPLOYMENTS_AI_CONTROL_TABLE               = aws_dynamodb_table.platform["control"].name
      DEPLOYMENTS_AI_EVENTS_TABLE                = aws_dynamodb_table.platform["events"].name
      DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE = aws_dynamodb_table.platform["identity-email-outbox"].name
      DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCE         = jsonencode(var.memory_jwt_audience)
      DEPLOYMENTS_AI_MEMORY_JWT_ISSUER           = var.memory_jwt_issuer
      DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE     = aws_dynamodb_table.request_admission.name
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS       = local.tenant_limit_defaults_json
      DEPLOYMENTS_AI_USAGE_TABLE                 = aws_dynamodb_table.platform["usage"].name
    }
  }
}

resource "aws_apigatewayv2_api" "memory" {
  name          = "memory"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "memory" {
  api_id                 = aws_apigatewayv2_api.memory.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.memory_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "identity" {
  api_id                 = aws_apigatewayv2_api.memory.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.identity_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "memory" {
  for_each = local.memory_api_routes

  api_id             = aws_apigatewayv2_api.memory.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.memory.id}"
}

resource "aws_apigatewayv2_route" "identity" {
  api_id             = aws_apigatewayv2_api.memory.id
  authorization_type = "NONE"
  route_key          = "GET /v1/whoami"
  target             = "integrations/${aws_apigatewayv2_integration.identity.id}"
}

resource "aws_apigatewayv2_stage" "memory" {
  api_id      = aws_apigatewayv2_api.memory.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "memory_api" {
  statement_id  = "AllowLocalMemoryApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.memory_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.memory.execution_arn}/*/*"
}

resource "aws_lambda_permission" "identity_api" {
  statement_id  = "AllowLocalIdentityApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.identity_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.memory.execution_arn}/*/*"
}

resource "aws_cloudwatch_event_rule" "memory_reconcile_schedule" {
  for_each = local.memory_reconciliation_scope_map

  name                = "memory-reconcile-${substr(sha256(each.key), 0, 10)}"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "memory_reconcile_schedule" {
  for_each = aws_cloudwatch_event_rule.memory_reconcile_schedule

  rule      = each.value.name
  target_id = "memory-reconcile"
  arn       = aws_lambda_function.memory_worker["memory-reconcile"].arn
  input = jsonencode({
    environmentId  = local.memory_reconciliation_scope_map[each.key].environment_id
    organizationId = local.memory_reconciliation_scope_map[each.key].organization_id
    projectId      = local.memory_reconciliation_scope_map[each.key].project_id
    workspaceId    = try(local.memory_reconciliation_scope_map[each.key].workspace_id, null)
  })
}

resource "aws_lambda_permission" "memory_reconcile_schedule" {
  for_each = aws_cloudwatch_event_rule.memory_reconcile_schedule

  statement_id  = "AllowLocalMemoryReconcile${substr(sha256(each.key), 0, 12)}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.memory_worker["memory-reconcile"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}

resource "aws_cloudwatch_event_rule" "memory_operation_reconcile_schedule" {
  name                = "memory-operation-reconcile"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "memory_operation_reconcile_schedule" {
  rule      = aws_cloudwatch_event_rule.memory_operation_reconcile_schedule.name
  target_id = "memory-operation-reconcile"
  arn       = aws_lambda_function.memory_operation_reconciler.arn
}

resource "aws_lambda_permission" "memory_operation_reconcile_schedule" {
  statement_id  = "AllowLocalMemoryOperationReconcile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.memory_operation_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.memory_operation_reconcile_schedule.arn
}
