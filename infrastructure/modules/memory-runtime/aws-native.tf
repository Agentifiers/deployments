locals {
  # Memory targets must catalog indexes under this prefix (enforced by
  # packages/memory awsNativeTargetLocation) so a shared domain keeps Memory and
  # Brain roles out of each other's indexes.
  opensearch_index_resources = var.aws_native_enabled ? ["${var.opensearch_domain_arn}/memory-*"] : []
  # Async purge task status/cleanup and the snapshot-repository absence check are
  # cluster-level paths outside any index.
  opensearch_task_resources        = var.aws_native_enabled ? ["${var.opensearch_domain_arn}/_tasks/*"] : []
  opensearch_task_result_resources = var.aws_native_enabled ? ["${var.opensearch_domain_arn}/.tasks/_doc/*"] : []
  opensearch_snapshot_resources    = var.aws_native_enabled ? ["${var.opensearch_domain_arn}/_snapshot/*"] : []
}

resource "aws_iam_policy" "worker_aws_native" {
  count       = var.aws_native_enabled ? 1 : 0
  name_prefix = "${local.name_prefix}-worker-memory-search-"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut"]
        Resource = local.opensearch_index_resources
      },
    ]
  })
  tags = local.common_tags
}
