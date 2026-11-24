locals {
  federation_key_arn = one(concat(aws_kms_key.federation_unprotected[*].arn, aws_kms_key.federation_protected[*].arn))
  federation_key_id  = one(concat(aws_kms_key.federation_unprotected[*].key_id, aws_kms_key.federation_protected[*].key_id))
}

resource "aws_kms_key" "federation_unprotected" {
  count                   = var.deletion_protection_enabled ? 0 : 1
  description             = "${local.name} customer identity provider client secrets"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  tags                    = merge(local.tags, { Name = "${local.name}-federation" })
}

resource "aws_kms_key" "federation_protected" {
  count                   = var.deletion_protection_enabled ? 1 : 0
  description             = "${local.name} customer identity provider client secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(local.tags, { Name = "${local.name}-federation" })

  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "federation" {
  name          = "alias/${local.name}-federation"
  target_key_id = local.federation_key_id
}

resource "aws_iam_role_policy" "api_federation" {
  name = "open-identity-provider-client-secrets"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["kms:Decrypt"]
      Resource  = local.federation_key_arn
      Condition = { StringEquals = { "kms:EncryptionContext:purpose" = "identity-provider-client-secret" } }
    }]
  })
}

# Second-factor TOTP secrets are sealed under the same key, bound to their own purpose so this
# grant can never open an identity provider client secret.
resource "aws_iam_role_policy" "api_mfa_secrets" {
  name = "seal-and-open-mfa-secrets"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource = local.federation_key_arn
      Condition = {
        StringEquals                = { "kms:EncryptionContext:purpose" = "mfa-totp-secret" }
        "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = ["principalId", "purpose", "stage"] }
      }
    }]
  })
}
