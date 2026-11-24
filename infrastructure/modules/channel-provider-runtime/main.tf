locals {
  name_prefix   = "channel"
  domain_name   = lower(trimspace(var.domain_name))
  custom_domain = local.domain_name != ""
  # Exact https origin for channel ingress, the credential API, and OAuth callbacks.
  public_origin = local.custom_domain ? "https://${local.domain_name}" : aws_apigatewayv2_api.public.api_endpoint
  jwt_authorizer_fingerprint = substr(sha256(jsonencode({
    audiences = var.jwt_audience
    issuer    = var.jwt_issuer
  })), 0, 12)
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  workers = {
    channel-delivery = {
      handler = "delivery.handler"
      queue   = aws_sqs_queue.runtime["channel-delivery"].arn
    }
    provider-tools = {
      handler = "provider-tools.handler"
      queue   = aws_sqs_queue.runtime["provider-tools"].arn
    }
  }
  credential_vault_sources = {
    reader = ["channel-ingress", "channel-delivery", "provider-tools"]
    writer = ["credential-api", "oauth-api", "oauth-refresh"]
  }
  runtime_functions  = toset(["channel-ingress", "channel-delivery", "credential-api", "oauth-api", "oauth-refresh", "provider-tools"])
  credential_writers = ["credential-api", "oauth-api", "oauth-refresh"]
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each = toset(["channel-ingress", "channel-delivery", "provider-tools"])

  name                      = "${each.key}-dlq${each.key == "channel-ingress" ? ".fifo" : ""}"
  fifo_queue                = each.key == "channel-ingress"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "runtime" {
  for_each = toset(["channel-ingress", "channel-delivery", "provider-tools"])

  name                       = "${each.key}${each.key == "channel-ingress" ? ".fifo" : ""}"
  fifo_queue                 = each.key == "channel-ingress"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 345600
  visibility_timeout_seconds = each.key == "channel-ingress" ? 370 : each.key == "provider-tools" ? 360 : 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "runtime" {
  for_each       = { "channel-delivery" = "channel.delivery.queued", "provider-tools" = "provider.tool.requested" }
  name           = each.key
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source        = ["deployments-ai.platform"]
    "detail-type" = [each.value]
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "runtime" {
  for_each       = aws_cloudwatch_event_rule.runtime
  event_bus_name = var.event_bus_name
  rule           = each.value.name
  arn            = aws_sqs_queue.runtime[each.key].arn
  target_id      = each.key
  dead_letter_config { arn = aws_sqs_queue.dlq[each.key].arn }
}

data "aws_iam_policy_document" "eventbridge_queue" {
  for_each = aws_cloudwatch_event_rule.runtime
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runtime[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge" {
  for_each  = data.aws_iam_policy_document.eventbridge_queue
  queue_url = aws_sqs_queue.runtime[each.key].url
  policy    = each.value.json
}

data "aws_iam_policy_document" "eventbridge_dlq" {
  for_each = aws_cloudwatch_event_rule.runtime
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge_dlq" {
  for_each  = data.aws_iam_policy_document.eventbridge_dlq
  queue_url = aws_sqs_queue.dlq[each.key].url
  policy    = each.value.json
}

resource "aws_cloudwatch_log_group" "runtime" {
  for_each          = local.runtime_functions
  name              = "/aws/lambda/${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "runtime" {
  for_each             = local.runtime_functions
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_security_group" "delivery" {
  count = var.network == null ? 0 : 1

  name_prefix = "${local.name_prefix}-delivery-"
  description = "Channel delivery egress to private streams and public providers"
  vpc_id      = var.network.vpc_id

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-delivery" })
}

data "aws_iam_policy_document" "credential_vault_assume" {
  for_each = local.credential_vault_sources

  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type = "AWS"
      identifiers = concat(
        [for name in each.value : aws_iam_role.runtime[name].arn],
        each.key == "reader" ? var.credential_vault_reader_principal_arns : [],
      )
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/accessMode"
      values   = [each.key]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["accessMode", "environmentId", "organizationId", "projectId"]
    }
    dynamic "condition" {
      for_each = toset(["environmentId", "organizationId", "projectId"])
      content {
        test     = "Null"
        variable = "aws:RequestTag/${condition.key}"
        values   = ["false"]
      }
    }
  }
}

resource "aws_iam_role" "credential_vault" {
  for_each             = data.aws_iam_policy_document.credential_vault_assume
  name                 = "${local.name_prefix}-credential-vault-${each.key}"
  assume_role_policy   = each.value.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "runtime" {
  for_each = local.runtime_functions

  dynamic "statement" {
    for_each = [contains(local.credential_writers, each.key) ? "writer" : "reader"]
    content {
      sid       = "AssumeCredentialVault"
      actions   = ["sts:AssumeRole", "sts:TagSession"]
      resources = [aws_iam_role.credential_vault[statement.value].arn]
    }
  }

  # oauth-refresh is IAM-invoked: it never authorizes a human principal and reads tenant
  # records only through the tag-scoped credential-vault writer session.
  dynamic "statement" {
    for_each = contains(local.credential_writers, each.key) && each.key != "oauth-refresh" ? [1] : []
    content {
      sid       = "AuthorizePlatformIdentity"
      actions   = ["dynamodb:GetItem"]
      resources = [var.control_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values = [
          "ORG#*",
          "PRINCIPAL#*",
          "UNIQUE#environment-id",
        ]
      }
    }
  }

  # Single-flight refresh claims (oauth-refresh Lambda and the oauth-api JWT refresh route):
  # ORG#<org>#ENV#<env> / OAUTH-REFRESH-CLAIM#<connection>#<generation>.
  dynamic "statement" {
    for_each = contains(["oauth-api", "oauth-refresh"], each.key) ? [1] : []
    content {
      sid = "CoordinateOAuthRefreshClaims"
      actions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:TransactWriteItems",
      ]
      resources = [var.execution_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["ORG#*#ENV#*"]
      }
    }
  }

  # DynamoDB transactions authorize the organization erasure fence through ConditionCheckItem.
  dynamic "statement" {
    for_each = contains(["oauth-api", "oauth-refresh"], each.key) ? [1] : []
    content {
      sid       = "CheckOAuthRefreshOrganizationFence"
      actions   = ["dynamodb:ConditionCheckItem"]
      resources = [var.control_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["ORG#*"]
      }
    }
  }

  # Claim puts and deletes maintain their tenant inventory row in the same transaction.
  dynamic "statement" {
    for_each = contains(["oauth-api", "oauth-refresh"], each.key) ? [1] : []
    content {
      sid       = "WriteOAuthRefreshClaimInventory"
      actions   = ["dynamodb:DeleteItem", "dynamodb:PutItem"]
      resources = [var.control_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["ORG#*#GOVERNANCE-INVENTORY", "ORG#*#GOVERNANCE-INVENTORY#SHARD#*"]
      }
    }
  }

  # Writers read the shard-writes marker before placing governance inventory locators.
  dynamic "statement" {
    for_each = contains(["oauth-api", "oauth-refresh"], each.key) ? [1] : []
    content {
      sid       = "ReadGovernanceInventoryLayout"
      actions   = ["dynamodb:GetItem"]
      resources = [var.control_table_arn]
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "dynamodb:LeadingKeys"
        values   = ["GLOBAL#deploy-migration"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" ? [1] : []
    content {
      sid = "PersistChannelDeliveryState"
      actions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
      ]
      resources = [
        var.control_table_arn,
        var.events_table_arn,
        var.execution_table_arn,
        "${var.execution_table_arn}/index/*",
      ]
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" ? [1] : []
    content {
      sid       = "ReleaseThreadPublicationLeases"
      actions   = ["dynamodb:DeleteItem"]
      resources = [var.execution_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["RUNTIME-LEASE#*"]
      }
    }
  }

  # Lease deletion also removes its tenant inventory row in the same transaction.
  dynamic "statement" {
    for_each = each.key == "channel-delivery" ? [1] : []
    content {
      sid       = "ReleaseThreadPublicationInventory"
      actions   = ["dynamodb:DeleteItem"]
      resources = [var.control_table_arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["ORG#*#GOVERNANCE-INVENTORY", "ORG#*#GOVERNANCE-INVENTORY#SHARD#*"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" && strcontains(var.durable_streams_auth_secret_arn, ":ssm:") ? [1] : []
    content {
      sid       = "ReadDurableStreamsAuthToken"
      actions   = ["ssm:GetParameter"]
      resources = [var.durable_streams_auth_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" && strcontains(var.durable_streams_auth_secret_arn, ":secretsmanager:") ? [1] : []
    content {
      sid       = "ReadDurableStreamsAuthToken"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [var.durable_streams_auth_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" && var.network != null ? [1] : []
    content {
      sid = "VpcNetworking"
      actions = [
        "ec2:AssignPrivateIpAddresses",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:UnassignPrivateIpAddresses",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-delivery" && length(var.rcs_provider_role_arns) > 0 ? [1] : []
    content {
      sid       = "AssumeVerticalRcsDeliveryRoles"
      actions   = ["sts:AssumeRole"]
      resources = sort(tolist(var.rcs_provider_role_arns))
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-ingress" ? [1] : []
    content {
      sid       = "EnqueueIngress"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.runtime["channel-ingress"].arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "channel-ingress" ? [1] : []
    content {
      sid = "JournalIngressAcceptance"
      actions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:TransactWriteItems",
      ]
      resources = [var.control_table_arn, var.execution_table_arn]
    }
  }

  dynamic "statement" {
    for_each = contains(keys(local.workers), each.key) ? [1] : []
    content {
      sid = "ConsumeQueue"
      actions = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
      ]
      resources = [local.workers[each.key].queue]
    }
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime[each.key].arn}:*"]
  }
}

data "aws_iam_policy_document" "credential_reader" {
  statement {
    sid       = "ReadCredentialVault"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}#ENV#$${aws:PrincipalTag/environmentId}",
      ]
    }
  }
  statement {
    sid = "AuditCredentialReads"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.events_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}#ENV#$${aws:PrincipalTag/environmentId}",
      ]
    }
  }
  statement {
    sid = "WriteCredentialReadDirectory"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY",
        "ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY#SHARD#*",
      ]
    }
  }
  # Writers read the shard-writes marker before placing governance inventory locators.
  statement {
    sid       = "ReadGovernanceInventoryLayout"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["GLOBAL#deploy-migration"]
    }
  }
  # DynamoDB transactions authorize ConditionCheck through this underlying item action.
  statement {
    sid       = "CheckOrganizationErasureFence"
    actions   = ["dynamodb:ConditionCheckItem"]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}",
      ]
    }
  }
  statement {
    sid       = "DecryptCredentialVault"
    actions   = ["kms:Decrypt"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values = [
        "credentialId",
        "environmentId",
        "organizationId",
        "ownerId",
        "ownerType",
        "projectId",
        "purpose",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:environmentId"
      values   = ["$${aws:PrincipalTag/environmentId}"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:organizationId"
      values   = ["$${aws:PrincipalTag/organizationId}"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:projectId"
      values   = ["$${aws:PrincipalTag/projectId}"]
    }
  }
}

resource "aws_iam_policy" "credential_reader" {
  name   = "${local.name_prefix}-credential-vault-reader"
  policy = data.aws_iam_policy_document.credential_reader.json
  tags   = local.common_tags
}

data "aws_iam_policy_document" "credential_writer" {
  statement {
    sid = "WriteCredentialVault"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}#ENV#$${aws:PrincipalTag/environmentId}",
      ]
    }
  }
  # DynamoDB transactions authorize ConditionCheck through this underlying item action.
  statement {
    sid       = "CheckOrganizationErasureFence"
    actions   = ["dynamodb:ConditionCheckItem"]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}",
      ]
    }
  }
  statement {
    sid = "WriteCredentialLifecycle"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.control_table_arn, var.events_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#$${aws:PrincipalTag/organizationId}",
        "ORG#$${aws:PrincipalTag/organizationId}#ENV#$${aws:PrincipalTag/environmentId}",
        "ORG#$${aws:PrincipalTag/organizationId}#AGGREGATE#*",
        "ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY",
        "ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY#SHARD#*",
        "UNIQUE#environment%3A$${aws:PrincipalTag/environmentId}%3Aoauth-state-hash",
        "UNIQUE#environment%3A$${aws:PrincipalTag/environmentId}%3Aprovider-connection%3A*",
      ]
    }
  }
  # Writers read the shard-writes marker before placing governance inventory locators.
  statement {
    sid       = "ReadGovernanceInventoryLayout"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["GLOBAL#deploy-migration"]
    }
  }
  statement {
    sid       = "EncryptCredentialVault"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values = [
        "credentialId",
        "environmentId",
        "organizationId",
        "ownerId",
        "ownerType",
        "projectId",
        "purpose",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:environmentId"
      values   = ["$${aws:PrincipalTag/environmentId}"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:organizationId"
      values   = ["$${aws:PrincipalTag/organizationId}"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:projectId"
      values   = ["$${aws:PrincipalTag/projectId}"]
    }
  }
}

resource "aws_iam_policy" "credential_writer" {
  name   = "${local.name_prefix}-credential-vault-writer"
  policy = data.aws_iam_policy_document.credential_writer.json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "credential_vault" {
  for_each = {
    reader = aws_iam_policy.credential_reader.arn
    writer = aws_iam_policy.credential_writer.arn
  }
  role       = aws_iam_role.credential_vault[each.key].name
  policy_arn = each.value
}

resource "aws_iam_role_policy" "runtime" {
  for_each = data.aws_iam_policy_document.runtime
  name     = "runtime"
  role     = aws_iam_role.runtime[each.key].id
  policy   = each.value.json
}
