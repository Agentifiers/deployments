data "aws_iam_policy_document" "identity_federation" {
  count = var.identity_federation == null ? 0 : 1

  statement {
    sid       = "SealIdentityProviderClientSecrets"
    actions   = ["kms:GenerateDataKey"]
    resources = [var.identity_federation.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:purpose"
      values   = ["identity-provider-client-secret"]
    }
  }
}

resource "aws_iam_role_policy" "identity_federation" {
  count = var.identity_federation == null ? 0 : 1

  name   = "seal-identity-provider-client-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.identity_federation[0].json
}
