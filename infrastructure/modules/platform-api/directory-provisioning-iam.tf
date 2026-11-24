data "aws_iam_policy_document" "directory_provisioning" {
  # SCIM creates a principal's security state (PRINCIPAL#<id>) and BFF revocation fence
  # (BFF-IDENTITY-FENCE#<id>). Accepted risk: PRINCIPAL#* also covers the principal-credential
  # (password hash) rows in the same partition.
  statement {
    sid = "ProvisionDirectoryPrincipals"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.identity_table_arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["PRINCIPAL#*", "BFF-IDENTITY-FENCE#*"]
    }
  }
}

resource "aws_iam_role_policy" "directory_provisioning" {
  name   = "provision-directory-principals"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.directory_provisioning.json
}
