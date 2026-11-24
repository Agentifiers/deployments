data "aws_iam_policy_document" "lambda" {
  dynamic "statement" {
    for_each = trimspace(var.observability_secret_arn) == "" ? [] : [1]
    content {
      sid       = "ReadObservabilityServiceCredential"
      actions   = ["ssm:GetParameter"]
      resources = [var.observability_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = trimspace(var.model_grants_parameter_arn) == "" ? [] : [1]
    content {
      sid       = "ReadModelGrants"
      actions   = ["ssm:GetParameter"]
      resources = [var.model_grants_parameter_arn]
    }
  }

  statement {
    sid       = "ReadSystemOperatorConfiguration"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.system_operator.arn]
  }

  dynamic "statement" {
    for_each = var.model_gateway_token_issuer == null ? [] : [1]
    content {
      sid       = "InvokeBrainModelTokenIssuer"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.model_gateway_token_issuer.arn]
    }
  }

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
    for_each = trimspace(var.oauth_refresh_function_arn) == "" ? [] : [1]
    content {
      sid       = "InvokeOAuthRefresh"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.oauth_refresh_function_arn]
    }
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

  dynamic "statement" {
    for_each = var.principal_status_function == null ? [] : [1]
    content {
      sid       = "InvokePrincipalStatus"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.principal_status_function.arn]
    }
  }

  # Organization invitation creation commits its protected email delivery to the identity outbox
  # in the same transaction, envelope-encrypted under the identity email key.
  dynamic "statement" {
    for_each = trimspace(var.identity_email_kms_key_arn) == "" ? [] : [1]
    content {
      sid = "QueueOrganizationInvitationEmail"
      actions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:PutItem",
        "dynamodb:TransactWriteItems",
      ]
      resources = [var.identity_email_table_arn]
    }
  }

  dynamic "statement" {
    for_each = trimspace(var.identity_email_kms_key_arn) == "" ? [] : [1]
    content {
      sid       = "ProtectOrganizationInvitationEmail"
      actions   = ["kms:GenerateDataKey"]
      resources = [var.identity_email_kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:purpose"
        values   = ["organization-invitation"]
      }

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:stage"
        values   = [var.environment]
      }

      condition {
        test     = "ForAllValues:StringEquals"
        variable = "kms:EncryptionContextKeys"
        values   = ["actionId", "deliveryId", "invitationId", "purpose", "stage"]
      }

      condition {
        test     = "Null"
        variable = "kms:EncryptionContext:deliveryId"
        values   = ["false"]
      }
    }
  }

  statement {
    sid = "AccessAgentLifecycleControlItems"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.control_table_arn]
  }

  statement {
    sid       = "AdmitOrganizationRequests"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.request_admission_table_arn]
  }

  statement {
    sid = "ReadGovernanceDownloads"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      for bucket_arn in concat([var.governance_bucket_arn], var.legacy_governance_bucket_arns) : "${bucket_arn}/governance/*"
    ]
  }

  statement {
    sid       = "EnqueueGovernanceOperations"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.governance.arn]
  }

  statement {
    sid       = "EnqueueEvaluationJobs"
    actions   = ["sqs:SendMessage"]
    resources = [var.evaluation_queue_arn]
  }

  statement {
    sid = "WriteBrainKnowledgeContent"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [
      for bucket_arn in concat([var.platform_artifact_bucket_arn], var.legacy_platform_artifact_bucket_arns) : "${bucket_arn}/organizations/*/brains/*"
    ]
  }

  statement {
    sid     = "WriteEvaluationMaterial"
    actions = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = flatten([
      for bucket_arn in concat([var.platform_artifact_bucket_arn], var.legacy_platform_artifact_bucket_arns) : [
        "${bucket_arn}/organizations/*/evaluation-cases/*",
        "${bucket_arn}/organizations/*/evaluation-reports/*",
      ]
    ])
  }

  statement {
    sid = "WriteHostedCodeArtifacts"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${var.platform_artifact_bucket_arn}/organizations/*/hosted-code-artifacts/*"]
  }

  statement {
    sid     = "QueryAgentLifecycleControlData"
    actions = ["dynamodb:Query"]
    resources = [
      var.control_table_arn,
      "${var.control_table_arn}/index/*",
    ]
  }

  statement {
    sid = "ReadEventsAndDurableIdempotency"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]
    resources = [
      var.events_table_arn,
      "${var.events_table_arn}/index/*",
    ]
  }

  statement {
    sid = "AccessBrainExecutionData"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = [
      var.dynamodb_table_arns["execution"],
      "${var.dynamodb_table_arns["execution"]}/index/*",
    ]
  }

  statement {
    sid     = "ReadTenantUsageAndSpend"
    actions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
    resources = [
      var.usage_table_arn,
      "${var.usage_table_arn}/index/*",
    ]
  }

  statement {
    sid = "CommitAgentLifecycleAndEvents"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.control_table_arn, var.events_table_arn]
  }

  # Artifact and governance objects are SSE-KMS under the shared key; S3 uses it on the caller's behalf.
  statement {
    sid       = "ArtifactObjectEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }

  # Shared data key grants are scoped to the fixed encryption context each envelope uses, so this
  # role cannot decrypt ciphertext that other features protect under the same key.
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
    sid       = "ProtectOperationalReadCursors"
    actions   = ["kms:Decrypt", "kms:Encrypt"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:purpose"
      values   = ["operational-read-cursor"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["purpose"]
    }
  }

  statement {
    sid       = "ProtectAdministrationCredentials"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["credentialId", "environmentId", "organizationId", "ownerId", "ownerType", "projectId", "purpose"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:credentialId"
      values   = ["false"]
    }
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [for log_group in aws_cloudwatch_log_group.lambda : "${log_group.arn}:*"]
  }

}

resource "aws_iam_role_policy" "lambda" {
  name   = "agent-lifecycle-api"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_iam_role_policy_attachment" "brain_runtime" {
  role       = aws_iam_role.lambda.name
  policy_arn = var.brain_runtime_policy_arn
}
