data "aws_iam_policy_document" "database_invoke" {
  statement {
    sid       = "InvokeAppsDatabase"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.database.arn]
  }
}

resource "aws_iam_policy" "database_invoke" {
  name        = "apps-database-invoke"
  description = "Call the apps-database Lambda, the only holder of control-path app database credentials."
  policy      = data.aws_iam_policy_document.database_invoke.json
  tags        = local.common_tags
}

data "aws_iam_policy_document" "domain_reconciler_invoke" {
  statement {
    sid       = "InvokeAppsDomains"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.domain_reconciler.arn]
  }
}

resource "aws_iam_policy" "domain_reconciler_invoke" {
  name        = "apps-domains-invoke"
  description = "Ask the apps-domains Lambda to converge one app domain now."
  policy      = data.aws_iam_policy_document.domain_reconciler_invoke.json
  tags        = local.common_tags
}

data "aws_iam_policy_document" "export_read" {
  statement {
    sid       = "ReadExports"
    actions   = ["s3:GetObject"]
    resources = [local.export_objects]
  }
}

resource "aws_iam_policy" "export_read" {
  name        = "apps-export-read"
  description = "Read app table exports to bundle them into an organization export."
  policy      = data.aws_iam_policy_document.export_read.json
  tags        = local.common_tags
}

data "aws_iam_policy_document" "release_upload" {
  statement {
    sid       = "CreateReleaseObjects"
    actions   = ["s3:PutObject"]
    resources = [local.release_objects]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }

  statement {
    sid       = "VerifyReleaseObjects"
    actions   = ["s3:GetObject"]
    resources = [local.release_objects]
  }
}

resource "aws_iam_policy" "release_upload" {
  name        = "apps-release-upload"
  description = "Presign create-only uploads of app release files."
  policy      = data.aws_iam_policy_document.release_upload.json
  tags        = local.common_tags
}

data "aws_iam_policy_document" "dev_sessions" {
  statement {
    sid       = "CreateAgentDevSessions"
    actions   = ["dynamodb:PutItem", "dynamodb:TransactWriteItems"]
    resources = [var.identity_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["APP-SESSION#*"]
    }
  }
}

resource "aws_iam_policy" "dev_sessions" {
  name        = "apps-dev-sessions"
  description = "Create the app sessions behind app.dev_token tokens."
  policy      = data.aws_iam_policy_document.dev_sessions.json
  tags        = local.common_tags
}
