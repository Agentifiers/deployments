locals {
  dynamodb_table_names = {
    for key, arn in var.dynamodb_table_arns : key => element(split("/", arn), 1)
  }
  runtime_environment = {
    DEPLOYMENTS_AI_CONTROL_TABLE   = local.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_EVENTS_TABLE    = local.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE = local.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_USAGE_TABLE     = local.dynamodb_table_names["usage"]
  }
  managed_worker_definitions = {
    maintenance = {
      description = "Runs explicitly scoped agent-email scheduled-send and retention maintenance."
      handler     = "maintenance-main.handler"
      memory_size = 512
      policy      = "maintenance"
      timeout     = 300
    }
    provider-events = {
      description = "Applies SES delivery, bounce, complaint, and rejection events."
      handler     = "provider-events-main.handler"
      memory_size = 512
      policy      = "events"
      timeout     = 60
    }
    send = {
      description = "Sends persisted outbound agent email through the selected SES placement."
      handler     = "send-main.handler"
      memory_size = 1024
      policy      = "send"
      timeout     = 300
    }
    stream-dispatcher = {
      description = "Dispatches durable agent-email send requests from the events stream."
      handler     = "stream-dispatcher-main.handler"
      memory_size = 256
      policy      = "stream-dispatcher"
      timeout     = 60
    }
  }
  runtime_role_names = toset(concat(["api", "inbound"], keys(local.managed_worker_definitions)))
}

data "aws_iam_policy_document" "runtime_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "runtime" {
  for_each = local.runtime_configured ? local.runtime_role_names : toset([])

  name              = "/aws/lambda/${local.runtime_name_prefix}-${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.tags
}

resource "aws_iam_role" "runtime" {
  for_each = local.runtime_configured ? local.runtime_role_names : toset([])

  name                 = "${local.runtime_name_prefix}-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.runtime_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "api_runtime" {
  statement {
    sid = "ReadWriteAgentEmailRecords"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactGetItems",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]
    resources = concat(
      values(var.dynamodb_table_arns),
      [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
    )
  }

  statement {
    sid       = "AdmitOrganizationRequests"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.request_admission_table_arn]
  }

  statement {
    sid = "ReadWriteAgentEmailObjects"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.email.arn}/*"]
  }

  dynamic "statement" {
    for_each = length(var.legacy_bucket_arns) > 0 ? [1] : []
    content {
      sid = "ReadDeleteLegacyAgentEmailObjects"
      actions = [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetObject",
        "s3:GetObjectVersion",
      ]
      resources = [for bucket_arn in var.legacy_bucket_arns : "${bucket_arn}/*"]
    }
  }

  statement {
    sid       = "ListAgentEmailObjects"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.email.arn]
  }


  dynamic "statement" {
    for_each = length(var.legacy_bucket_arns) > 0 ? [1] : []
    content {
      sid       = "ListLegacyAgentEmailObjects"
      actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
      resources = var.legacy_bucket_arns
    }
  }

  # Idempotency responses are sealed under the shared data key; their context always names the
  # idempotency key and nothing else beyond the request fingerprint and principal.
  statement {
    sid       = "ProtectIdempotencyResponses"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["fingerprint", "idempotencyKey", "principalId"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:idempotencyKey"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = length(var.regional_event_topic_kms_key_arns) > 0 ? [1] : []
    content {
      sid = "UseRegionalEventTopicEncryption"
      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
      ]
      resources = values(var.regional_event_topic_kms_key_arns)
    }
  }

  statement {
    sid     = "EnqueueAgentEmailWork"
    actions = ["sqs:SendMessage"]
    resources = [
      aws_sqs_queue.worker["events"].arn,
      aws_sqs_queue.worker["inbound"].arn,
      aws_sqs_queue.worker["send"].arn,
    ]
  }

  statement {
    sid = "ManageAgentEmailSesResources"
    actions = [
      "ses:CreateConfigurationSet",
      "ses:CreateConfigurationSetEventDestination",
      "ses:CreateDedicatedIpPool",
      "ses:CreateEmailIdentity",
      "ses:CreateMultiRegionEndpoint",
      "ses:CreateTenant",
      "ses:CreateTenantResourceAssociation",
      "ses:DeleteConfigurationSet",
      "ses:DeleteDedicatedIpPool",
      "ses:DeleteEmailIdentity",
      "ses:DeleteMultiRegionEndpoint",
      "ses:DeleteSuppressedDestination",
      "ses:DeleteTenant",
      "ses:DeleteTenantResourceAssociation",
      "ses:GetAccount",
      "ses:GetConfigurationSet",
      "ses:GetDedicatedIpPool",
      "ses:GetEmailIdentity",
      "ses:GetMultiRegionEndpoint",
      "ses:GetReputationEntity",
      "ses:GetTenant",
      "ses:ListTagsForResource",
      "ses:ListTenantResources",
      "ses:PutConfigurationSetDeliveryOptions",
      "ses:PutConfigurationSetSendingOptions",
      "ses:PutConfigurationSetSuppressionOptions",
      "ses:PutEmailIdentityMailFromAttributes",
      "ses:PutSuppressedDestination",
      "ses:PutTenantSuppressionAttributes",
      "ses:ReplicateEmailIdentityDKIMSigningKey",
      "ses:SendEmail",
      "ses:SendRawEmail",
      "ses:TagResource",
      "ses:UpdateConfigurationSetEventDestination",
      "ses:UpdateReputationEntityCustomerManagedStatus",
      "sns:CreateTopic",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:TagResource",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "CreateSesServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::*:role/aws-service-role/ses.amazonaws.com/AWSServiceRoleForAmazonSES"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["ses.amazonaws.com"]
    }
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.runtime_configured ? ["${aws_cloudwatch_log_group.runtime["api"].arn}:*"] : ["*"]
  }
}

data "aws_iam_role" "inbound_worker" {
  count = contains(keys(var.lambda_function_arns), "inbound") && contains(keys(var.lambda_role_names), "inbound") ? 1 : 0

  name = var.lambda_role_names["inbound"]
}

locals {
  inbound_role_arns = concat(
    [for name, role in aws_iam_role.runtime : role.arn if name == "inbound"],
    data.aws_iam_role.inbound_worker[*].arn,
  )
}

data "aws_iam_policy_document" "inbound_attachment_capture" {
  count = length(local.inbound_role_arns) > 0 ? 1 : 0

  statement {
    sid       = "AssumeIngressAttachmentCapture"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [var.ingress_attachment_capture_role_arn]
  }

  statement {
    sid       = "InvokeDocumentExtraction"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.document_extraction_function.arn]
  }
}

data "aws_iam_policy_document" "inbound_runtime" {
  source_policy_documents = data.aws_iam_policy_document.inbound_attachment_capture[*].json

  statement {
    sid = "PersistInboundAgentEmail"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactGetItems",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]
    resources = concat(
      values(var.dynamodb_table_arns),
      [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
    )
  }

  statement {
    sid = "ReadWriteInboundObjects"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.email.arn}/*"]
  }

  statement {
    sid       = "InspectInboundObjectExistence"
    actions   = ["s3:ListBucketVersions"]
    resources = [aws_s3_bucket.email.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.raw_prefix}*"]
    }
  }

  statement {
    sid = "ConsumeInboundQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.worker["inbound"].arn]
  }

  dynamic "statement" {
    for_each = local.inbound_runtime_configured ? [1] : []
    content {
      sid       = "EnqueueAgentRuns"
      actions   = ["sqs:SendMessage"]
      resources = [var.agent_run_queue_arn]
    }
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.runtime_configured ? ["${aws_cloudwatch_log_group.runtime["inbound"].arn}:*"] : ["*"]
  }
}

resource "aws_iam_role_policy" "runtime" {
  for_each = local.runtime_configured ? {
    api     = data.aws_iam_policy_document.api_runtime.json
    inbound = data.aws_iam_policy_document.inbound_runtime.json
  } : {}

  name   = "runtime"
  role   = aws_iam_role.runtime[each.key].id
  policy = each.value
}

data "aws_iam_policy_document" "managed_worker_logs" {
  for_each = local.runtime_configured ? local.managed_worker_definitions : {}

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime[each.key].arn}:*"]
  }
}

resource "aws_iam_role_policy" "managed_worker_logs" {
  for_each = data.aws_iam_policy_document.managed_worker_logs

  name   = "logs"
  role   = aws_iam_role.runtime[each.key].id
  policy = each.value.json
}

resource "aws_iam_role_policy_attachment" "managed_worker" {
  for_each = local.runtime_configured ? local.managed_worker_definitions : {}

  policy_arn = aws_iam_policy.worker[each.value.policy].arn
  role       = aws_iam_role.runtime[each.key].name
}

resource "aws_lambda_function" "api" {
  count = local.runtime_configured ? 1 : 0

  function_name     = "${local.runtime_name_prefix}-api"
  description       = "Authenticated hosted agent-email API."
  architectures     = ["arm64"]
  handler           = "api-main.handler"
  memory_size       = 512
  role              = aws_iam_role.runtime["api"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.runtime_artifact_bucket
  s3_key            = var.runtime_artifact_key
  s3_object_version = var.runtime_artifact_version
  timeout           = 29

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = trimspace(var.events_stream_arn) != ""
      error_message = "The managed agent-email API requires the events stream for durable outbound dispatch."
    }

    precondition {
      condition     = trimspace(var.end_user_subject_key_arn) != ""
      error_message = "The managed agent-email API requires the end-user subject key to key mail correspondents."
    }
  }

  environment {
    variables = merge(local.runtime_environment, {
      DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET              = aws_s3_bucket.email.id
      DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON = jsonencode(var.legacy_bucket_names)
      DEPLOYMENTS_AI_AGENT_EMAIL_CONFIGURATION_SET   = aws_sesv2_configuration_set.email.configuration_set_name
      DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_QUEUE_ARN     = aws_sqs_queue.worker["events"].arn
      DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_TOPIC_ARN     = aws_sns_topic.events.arn
      DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL    = aws_sqs_queue.worker["events"].url
      DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_QUEUE_URL   = aws_sqs_queue.worker["inbound"].url
      DEPLOYMENTS_AI_AGENT_EMAIL_RAW_PREFIX          = local.raw_prefix
      DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL      = aws_sqs_queue.worker["send"].url
      DEPLOYMENTS_AI_AGENT_EMAIL_HOSTED_DOMAIN       = var.domain
      DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS = jsonencode(
        merge(var.regional_event_topic_kms_key_arns, { (var.region) = var.data_kms_key_arn })
      )
      DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_READY = tostring(
        var.activate_receipt_rule_set &&
        var.enable_catch_all_receiving &&
        try(aws_lambda_event_source_mapping.managed_inbound[0].uuid != "", false)
      )
      DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN = var.data_kms_key_arn
      DEPLOYMENTS_AI_API_JWKS_URI                = var.api_jwks_uri
      DEPLOYMENTS_AI_API_JWT_AUDIENCE            = var.api_jwt_audience
      DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE       = var.api_jwt_claim_profile
      DEPLOYMENTS_AI_API_JWT_ISSUER              = var.api_jwt_issuer
      DEPLOYMENTS_AI_AWS_ACCOUNT_ID              = var.account_id
      DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE     = var.request_admission_table_name
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS       = var.tenant_limit_defaults_json
      DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN    = var.end_user_subject_key_arn
      }, var.default_model_spend_ceiling_usd_micros == null ? {} : {
      DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
    })
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime, aws_iam_role_policy.end_user_subject_key]
}

resource "aws_lambda_function" "inbound" {
  count = local.inbound_runtime_configured ? 1 : 0

  function_name     = "${local.runtime_name_prefix}-inbound"
  description       = "Persists inbound SES email and fans active inbox bindings into agent workflows."
  architectures     = ["arm64"]
  handler           = "inbound-main.handler"
  memory_size       = 1024
  role              = aws_iam_role.runtime["inbound"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.runtime_artifact_bucket
  s3_key            = var.runtime_artifact_key
  s3_object_version = var.runtime_artifact_version
  timeout           = 300

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition = (
        trimspace(var.agent_run_queue_arn) != "" &&
        trimspace(var.agent_run_queue_url) != "" &&
        trimspace(var.end_user_subject_key_arn) != ""
      )
      error_message = "The managed inbound agent-email runtime requires the canonical agent run queue ARN and URL and the end-user subject key."
    }
  }

  environment {
    variables = merge(local.runtime_environment, {
      DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET                  = aws_s3_bucket.email.id
      DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON     = jsonencode(var.legacy_bucket_names)
      DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_QUEUE_URL       = aws_sqs_queue.worker["inbound"].url
      DEPLOYMENTS_AI_AGENT_EMAIL_RAW_PREFIX              = local.raw_prefix
      DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL                 = var.agent_run_queue_url
      DEPLOYMENTS_AI_ARTIFACT_BUCKET                     = var.artifact_bucket_name
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN                = var.data_kms_key_arn
      DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME   = var.document_extraction_function.function_name
      DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN = var.ingress_attachment_capture_role_arn
      DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN            = var.end_user_subject_key_arn
    })
  }

  tags       = local.tags
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime, aws_iam_role_policy.end_user_subject_key]
}

resource "aws_lambda_function" "managed_worker" {
  for_each = local.runtime_configured ? local.managed_worker_definitions : {}

  function_name     = "${local.runtime_name_prefix}-${each.key}"
  description       = each.value.description
  architectures     = ["arm64"]
  handler           = each.value.handler
  memory_size       = each.value.memory_size
  role              = aws_iam_role.runtime[each.key].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.runtime_artifact_bucket
  s3_key            = var.runtime_artifact_key
  s3_object_version = var.runtime_artifact_version
  timeout           = each.value.timeout

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(
      local.runtime_environment,
      contains(["maintenance", "send"], each.key) ? {
        DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET              = aws_s3_bucket.email.id
        DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON = jsonencode(var.legacy_bucket_names)
      } : {},
      contains(["maintenance", "send", "stream-dispatcher"], each.key) ? {
        DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL = aws_sqs_queue.worker["send"].url
      } : {},
      each.key == "send" ? {
        DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL = aws_sqs_queue.worker["events"].url
      } : {},
    )
  }

  tags = local.tags
  depends_on = [
    aws_cloudwatch_log_group.runtime,
    aws_iam_role_policy.managed_worker_logs,
    aws_iam_role_policy_attachment.managed_worker,
    terraform_data.hosted_send_suppression_isolation,
  ]
}

resource "aws_lambda_event_source_mapping" "managed_inbound" {
  count = local.inbound_runtime_configured ? 1 : 0

  batch_size                         = 3
  event_source_arn                   = aws_sqs_queue.worker["inbound"].arn
  function_name                      = aws_lambda_function.inbound[0].arn
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 1

  depends_on = [aws_iam_role_policy.runtime]
}

resource "aws_lambda_event_source_mapping" "managed_queue_worker" {
  for_each = local.runtime_configured ? {
    provider-events = "events"
    send            = "send"
  } : {}

  batch_size                         = each.key == "send" ? 5 : 10
  event_source_arn                   = aws_sqs_queue.worker[each.value].arn
  function_name                      = aws_lambda_function.managed_worker[each.key].arn
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 1

  depends_on = [aws_iam_role_policy_attachment.managed_worker]
}

resource "aws_lambda_event_source_mapping" "managed_maintenance" {
  count = local.runtime_configured ? 1 : 0

  batch_size       = 1
  event_source_arn = aws_sqs_queue.worker["maintenance"].arn
  function_name    = aws_lambda_function.managed_worker["maintenance"].arn

  depends_on = [aws_iam_role_policy_attachment.managed_worker]
}

resource "aws_lambda_event_source_mapping" "managed_events_stream" {
  count = local.runtime_configured ? 1 : 0

  batch_size                         = 100
  bisect_batch_on_function_error     = true
  event_source_arn                   = var.events_stream_arn
  function_name                      = aws_lambda_function.managed_worker["stream-dispatcher"].arn
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_retry_attempts             = 10
  parallelization_factor             = 2
  starting_position                  = "TRIM_HORIZON"
  maximum_batching_window_in_seconds = 1

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.stream_dispatcher_dlq.arn
    }
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb = {
          NewImage = {
            data = {
              M = {
                eventType = {
                  S = ["agent-email.send-requested"]
                }
              }
            }
            itemType = {
              S = ["semantic-event"]
            }
          }
        }
      })
    }
  }

  depends_on = [aws_iam_role_policy_attachment.managed_worker]
}

data "aws_iam_policy_document" "managed_scheduler_assume" {
  count = local.runtime_configured ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "managed_scheduler" {
  count = local.runtime_configured ? 1 : 0

  name                 = "${local.runtime_name_prefix}-maintenance-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.managed_scheduler_assume[0].json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "managed_scheduler" {
  count = local.runtime_configured ? 1 : 0

  name = "enqueue-maintenance"
  role = aws_iam_role.managed_scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "sqs:SendMessage"
      Effect   = "Allow"
      Resource = aws_sqs_queue.worker["maintenance"].arn
    }]
  })
}

resource "aws_scheduler_schedule" "managed_maintenance" {
  count = local.runtime_configured ? 1 : 0

  name                = "${local.runtime_name_prefix}-maintenance"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sqs_queue.worker["maintenance"].arn
    input    = jsonencode({ limit = 100, scheduledAt = "<aws.scheduler.scheduled-time>" })
    role_arn = aws_iam_role.managed_scheduler[0].arn

    sqs_parameters {
      message_group_id = "global"
    }
  }

  depends_on = [
    aws_iam_role_policy.managed_scheduler,
    aws_iam_role_policy_attachment.managed_worker,
  ]
}

resource "aws_cloudwatch_metric_alarm" "runtime_errors" {
  for_each = var.alarms_enabled && local.runtime_configured ? merge(
    { api = aws_lambda_function.api[0].function_name },
    local.inbound_runtime_configured ? {
      inbound = aws_lambda_function.inbound[0].function_name
    } : {},
    {
      for key, function in aws_lambda_function.managed_worker : key => function.function_name
    },
  ) : {}

  alarm_name          = "${local.runtime_name_prefix}-${each.key}-errors"
  alarm_description   = "Agent email ${each.key} Lambda reported an error."
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

  dimensions = {
    FunctionName = each.value
  }

  tags = local.tags
}
