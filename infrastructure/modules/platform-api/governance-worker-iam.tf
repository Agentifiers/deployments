data "aws_iam_policy_document" "governance_worker" {
  statement {
    sid       = "InvokeMemorySearchErasure"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.memory_erasure_function_arn]
  }

  statement {
    sid       = "InvokeBrainSearchErasure"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.brain_erasure_function_arn]
  }

  dynamic "statement" {
    for_each = trimspace(var.observability_erasure_function_arn) == "" ? [] : [1]
    content {
      sid       = "InvokeObservabilityErasure"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.observability_erasure_function_arn]
    }
  }

  statement {
    sid       = "ReadDurableStreamsToken"
    actions   = ["ssm:GetParameter"]
    resources = [var.durable_streams_auth_secret_arn]
  }

  statement {
    sid       = "DeleteErasedThreadTimers"
    actions   = ["scheduler:DeleteSchedule"]
    resources = ["arn:aws:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/${var.automation_scheduler_group_name}/*"]
  }

  dynamic "statement" {
    for_each = var.network == null ? [] : [1]
    content {
      sid = "VpcNetworking"
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
      ]
      resources = ["*"]
    }
  }

  statement {
    sid = "GovernanceTables"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = concat(
      values(var.dynamodb_table_arns),
      [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
    )
  }

  statement {
    sid = "GovernanceObjects"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectRetention",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectRetention",
    ]
    resources = concat(
      [
        "${var.agent_email_bucket_arn}/organizations/*",
        "${var.agent_email_bucket_arn}/raw/organizations/*",
        "${var.governance_bucket_arn}/governance/*",
        "${var.platform_artifact_bucket_arn}/*",
      ],
      flatten([
        for bucket_arn in var.legacy_agent_email_bucket_arns : [
          "${bucket_arn}/organizations/*",
          "${bucket_arn}/raw/organizations/*",
        ]
      ]),
      [for bucket_arn in var.legacy_governance_bucket_arns : "${bucket_arn}/governance/*"],
      [for bucket_arn in var.legacy_platform_artifact_bucket_arns : "${bucket_arn}/*"],
      var.agent_observability_quarantine_bucket_arn == null ? [] : ["${var.agent_observability_quarantine_bucket_arn}/organizations/*"],
    )
  }

  statement {
    sid     = "ListGovernanceObjectVersions"
    actions = ["s3:ListBucketVersions"]
    resources = concat(
      [
        var.agent_email_bucket_arn,
        var.governance_bucket_arn,
        var.platform_artifact_bucket_arn,
      ],
      var.legacy_agent_email_bucket_arns,
      var.legacy_governance_bucket_arns,
      var.legacy_platform_artifact_bucket_arns,
      var.agent_observability_quarantine_bucket_arn == null ? [] : [var.agent_observability_quarantine_bucket_arn],
    )
  }

  statement {
    sid       = "ProbeGovernanceObjects"
    actions   = ["s3:ListBucket"]
    resources = [var.governance_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["governance/*"]
    }
  }

  statement {
    sid       = "SignGovernanceManifests"
    actions   = ["kms:GetPublicKey", "kms:Sign"]
    resources = [var.governance_signing_key_arn]
  }

  statement {
    sid       = "GovernanceObjectEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }

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

  statement {
    sid = "ConsumeGovernanceQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.governance.arn]
  }

  statement {
    sid       = "EnqueueGovernanceRetention"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.governance.arn]
  }

  statement {
    sid = "WriteGovernanceWorkerLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.governance_worker.arn}:*"]
  }
}

resource "aws_iam_role_policy" "governance_worker" {
  name   = "governance-worker"
  role   = aws_iam_role.governance_worker.id
  policy = data.aws_iam_policy_document.governance_worker.json
}
