resource "aws_apigatewayv2_api" "public" {
  name          = "${local.name_prefix}-channel-webhooks"
  protocol_type = "HTTP"
  tags          = local.common_tags
}

resource "aws_apigatewayv2_integration" "ingress" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingress.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "credential_api" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.credential_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "oauth_api" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.oauth_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "terraform_data" "credential_api_authorizer_identity" {
  triggers_replace = [jsonencode({
    audiences = var.jwt_audience
    issuer    = var.jwt_issuer
  })]
}

resource "aws_apigatewayv2_authorizer" "credential_api" {
  api_id           = aws_apigatewayv2_api.public.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "credential-api"

  jwt_configuration {
    audience = var.jwt_audience
    issuer   = var.jwt_issuer
  }

  lifecycle {
    ignore_changes = [jwt_configuration]
  }
}

moved {
  from = aws_apigatewayv2_authorizer.credential_api["jwt"]
  to   = aws_apigatewayv2_authorizer.credential_api_v2["jwt"]
}

resource "aws_apigatewayv2_authorizer" "credential_api_v2" {
  # The stable key deliberately moves the historical singleton to a new state
  # address once; later identity changes use replace_triggered_by below.
  for_each = toset(["jwt"])

  api_id           = aws_apigatewayv2_api.public.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "credential-api-${local.jwt_authorizer_fingerprint}"

  jwt_configuration {
    audience = var.jwt_audience
    issuer   = var.jwt_issuer
  }

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [terraform_data.credential_api_authorizer_identity]
  }
}

resource "aws_apigatewayv2_route" "ingress" {
  api_id    = aws_apigatewayv2_api.public.id
  route_key = "POST /public/channels/{organizationId}/{environmentId}/{bindingId}/{provider}"
  target    = "integrations/${aws_apigatewayv2_integration.ingress.id}"
}

resource "aws_apigatewayv2_route" "credential_api" {
  for_each = toset([
    "DELETE /v1/environments/{environmentId}/credentials/{credentialId}",
    "POST /v1/environments/{environmentId}/credentials/{credentialId}",
    "PUT /v1/environments/{environmentId}/credentials/{credentialId}",
  ])

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "JWT"
  authorizer_id      = one(values(aws_apigatewayv2_authorizer.credential_api_v2)).id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.credential_api.id}"
}

resource "aws_apigatewayv2_route" "oauth_api" {
  for_each = toset([
    "DELETE /v1/environments/{environmentId}/provider-connections/{connectionId}/oauth",
    "POST /v1/environments/{environmentId}/provider-applications/{applicationId}/oauth/authorize",
    "POST /v1/environments/{environmentId}/provider-connections/{connectionId}/oauth/refresh",
  ])
  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "JWT"
  authorizer_id      = one(values(aws_apigatewayv2_authorizer.credential_api_v2)).id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.oauth_api.id}"
}

resource "aws_apigatewayv2_route" "oauth_callback" {
  api_id    = aws_apigatewayv2_api.public.id
  route_key = "GET /public/provider-connections/oauth/callback/{provider}"
  target    = "integrations/${aws_apigatewayv2_integration.oauth_api.id}"
}

# Public OAuth Client ID Metadata Document (CIMD) for vendor MCP authorization servers.
resource "aws_apigatewayv2_route" "oauth_client_metadata" {
  api_id    = aws_apigatewayv2_api.public.id
  route_key = "GET /public/provider-connections/oauth/client-metadata.json"
  target    = "integrations/${aws_apigatewayv2_integration.oauth_api.id}"
}

resource "aws_apigatewayv2_stage" "public" {
  api_id      = aws_apigatewayv2_api.public.id
  name        = "$default"
  auto_deploy = true
  tags        = local.common_tags
}

resource "aws_lambda_permission" "ingress" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingress.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

resource "aws_lambda_permission" "credential_api" {
  statement_id  = "AllowCredentialHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.credential_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*/v1/environments/*/credentials/*"
}

resource "aws_lambda_permission" "oauth_api" {
  statement_id  = "AllowOAuthHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.oauth_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? merge(
    {
      "channel-ingress" = aws_lambda_function.ingress.function_name
      "credential-api"  = aws_lambda_function.credential_api.function_name
      "oauth-api"       = aws_lambda_function.oauth_api.function_name
      "oauth-refresh"   = aws_lambda_function.oauth_refresh.function_name
    },
    { for key, value in aws_lambda_function.worker : key => value.function_name },
  ) : {}
  alarm_name          = "${each.key}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { FunctionName = each.value }
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_visible" {
  for_each            = var.alarms_enabled ? aws_sqs_queue.dlq : {}
  alarm_name          = "${each.key}-dlq-visible"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { QueueName = each.value.name }
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-http-api-5xx"
  alarm_description   = "The channel HTTP API is returning 5xx responses."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    ApiId = aws_apigatewayv2_api.public.id
    Stage = aws_apigatewayv2_stage.public.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# The public origin customers and providers see. The execute-api endpoint stays enabled so
# webhooks registered before the custom domain existed keep arriving.
resource "aws_acm_certificate" "public" {
  count = local.custom_domain ? 1 : 0

  domain_name       = local.domain_name
  validation_method = "DNS"
  tags              = merge(local.common_tags, { Name = local.domain_name })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.custom_domain ? {
    for option in aws_acm_certificate.public[0].domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "public" {
  count = local.custom_domain ? 1 : 0

  certificate_arn         = aws_acm_certificate.public[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "public" {
  count = local.custom_domain ? 1 : 0

  domain_name = local.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.public[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_api_mapping" "public" {
  count = local.custom_domain ? 1 : 0

  api_id      = aws_apigatewayv2_api.public.id
  domain_name = aws_apigatewayv2_domain_name.public[0].id
  stage       = aws_apigatewayv2_stage.public.id
}

resource "aws_route53_record" "public" {
  for_each = local.custom_domain ? toset(["A", "AAAA"]) : toset([])

  name    = local.domain_name
  type    = each.key
  zone_id = var.route53_zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_apigatewayv2_domain_name.public[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.public[0].domain_name_configuration[0].hosted_zone_id
  }
}
