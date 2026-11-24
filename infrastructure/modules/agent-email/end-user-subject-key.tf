data "aws_iam_policy_document" "end_user_subject_key" {
  count = var.enable_inbound_runtime ? 1 : 0

  statement {
    sid       = "ReadEndUserSubjectKey"
    actions   = ["ssm:GetParameter"]
    resources = [var.end_user_subject_key_arn]
  }
}

resource "aws_iam_role_policy" "end_user_subject_key" {
  for_each = local.runtime_configured && length(data.aws_iam_policy_document.end_user_subject_key) > 0 ? toset(["api", "inbound"]) : toset([])

  name   = "end-user-subject-key"
  role   = aws_iam_role.runtime[each.key].id
  policy = data.aws_iam_policy_document.end_user_subject_key[0].json
}

resource "aws_iam_role_policy" "inbound_worker_end_user_subject_key" {
  count = length(data.aws_iam_role.inbound_worker) > 0 && length(data.aws_iam_policy_document.end_user_subject_key) > 0 ? 1 : 0

  name   = "agent-email-end-user-subject-key"
  role   = data.aws_iam_role.inbound_worker[0].name
  policy = data.aws_iam_policy_document.end_user_subject_key[0].json
}
