locals {
  model_credential_key_arn = one(concat(aws_kms_key.model_credentials_unprotected[*].arn, aws_kms_key.model_credentials_protected[*].arn))
  model_credential_key_id  = one(concat(aws_kms_key.model_credentials_unprotected[*].key_id, aws_kms_key.model_credentials_protected[*].key_id))

  # The account administers the key but cannot use it through IAM policies: only principals named
  # here may encrypt or decrypt. The API seals organization model provider keys and never opens
  # them; only the model gateway task role opens them.
  model_credential_context_keys = ["credentialId", "keyVersion", "organizationId", "provider", "purpose", "stage"]
  model_credential_key_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "AdministerKey"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
        Action = [
          "kms:CancelKeyDeletion",
          "kms:CreateAlias",
          "kms:DeleteAlias",
          "kms:DescribeKey",
          "kms:DisableKey",
          "kms:DisableKeyRotation",
          "kms:EnableKey",
          "kms:EnableKeyRotation",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListAliases",
          "kms:ListGrants",
          "kms:ListKeyPolicies",
          "kms:ListKeyRotations",
          "kms:ListResourceTags",
          "kms:PutKeyPolicy",
          "kms:RevokeGrant",
          "kms:ScheduleKeyDeletion",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:UpdateAlias",
          "kms:UpdateKeyDescription",
        ]
        Resource = "*"
      },
      {
        Sid       = "SealModelProviderCredentials"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.lambda.arn }
        Action    = ["kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          StringEquals                = { "kms:EncryptionContext:purpose" = "model-provider-credential" }
          "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = local.model_credential_context_keys }
        }
      },
      ], try(var.model_credentials.gateway_role_arn, null) == null ? [] : [
      {
        Sid       = "OpenModelProviderCredentials"
        Effect    = "Allow"
        Principal = { AWS = var.model_credentials.gateway_role_arn }
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = {
          StringEquals                = { "kms:EncryptionContext:purpose" = "model-provider-credential" }
          "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = local.model_credential_context_keys }
        }
      },
    ])
  })
}

resource "aws_kms_key" "model_credentials_unprotected" {
  count = var.model_credentials != null && !try(var.model_credentials.deletion_protection_enabled, false) ? 1 : 0

  description             = "Deployments.ai platform ${var.environment} organization model provider keys"
  deletion_window_in_days = var.model_credentials.kms_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = local.model_credential_key_policy
  tags                    = merge(local.common_tags, { Name = "model-credentials" })
}

resource "aws_kms_key" "model_credentials_protected" {
  count = try(var.model_credentials.deletion_protection_enabled, false) ? 1 : 0

  description             = "Deployments.ai platform ${var.environment} organization model provider keys"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = local.model_credential_key_policy
  tags                    = merge(local.common_tags, { Name = "model-credentials" })

  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "model_credentials" {
  count = var.model_credentials == null ? 0 : 1

  name          = "alias/platform-model-credentials"
  target_key_id = local.model_credential_key_id
}
