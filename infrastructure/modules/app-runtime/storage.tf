resource "aws_s3_bucket" "apps" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.deletion_protection_enabled
  tags          = merge(local.common_tags, { Name = local.name })
}

resource "aws_s3_bucket_ownership_controls" "apps" {
  bucket = aws_s3_bucket.apps.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "apps" {
  bucket = aws_s3_bucket.apps.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "apps" {
  bucket = aws_s3_bucket.apps.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "apps_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.apps.arn,
      "${aws_s3_bucket.apps.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "CloudFrontReadsReleases"
    actions   = ["s3:GetObject"]
    resources = [local.release_objects]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.apps.arn, aws_cloudfront_multitenant_distribution.custom_domains.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "apps" {
  bucket = aws_s3_bucket.apps.id
  policy = data.aws_iam_policy_document.apps_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.apps]
}
