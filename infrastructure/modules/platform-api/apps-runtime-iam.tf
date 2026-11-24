resource "aws_iam_role_policy_attachment" "apps_database_invoke" {
  for_each = var.apps_runtime == null ? {} : {
    api               = aws_iam_role.lambda.name
    governance-worker = aws_iam_role.governance_worker.name
  }

  role       = each.value
  policy_arn = var.apps_runtime.invoke_policy_arn
}

resource "aws_iam_role_policy_attachment" "apps_domain_reconciler_invoke" {
  count = var.apps_runtime == null ? 0 : 1

  role       = aws_iam_role.lambda.name
  policy_arn = var.apps_runtime.domain_reconciler_invoke_policy_arn
}

resource "aws_iam_role_policy_attachment" "apps_export_read" {
  count = var.apps_runtime == null ? 0 : 1

  role       = aws_iam_role.governance_worker.name
  policy_arn = var.apps_runtime.export_read_policy_arn
}
