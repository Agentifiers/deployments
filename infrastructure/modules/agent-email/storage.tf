resource "aws_s3_bucket" "email" {
  bucket        = "${local.name_prefix}-${var.account_id}"
  force_destroy = !var.deletion_protection_enabled
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "email" {
  bucket                  = aws_s3_bucket.email.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "email" {
  bucket = aws_s3_bucket.email.id
  versioning_configuration {
    status = "Enabled"
  }
}

# SES receipt rules and the agent-email runtimes rely on bucket default encryption and never
# send SSE-KMS headers, so S3-managed keys protect stored mail without a customer-managed key.
resource "aws_s3_bucket_server_side_encryption_configuration" "email" {
  bucket = aws_s3_bucket.email.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "email" {
  bucket = aws_s3_bucket.email.id

  depends_on = [aws_s3_bucket_versioning.email]

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-current-raw-email"
    status = "Enabled"

    filter {
      prefix = local.raw_prefix
    }

    expiration {
      days = 366
    }

    # Raw MIME keys are immutable per SES receipt. Other objects retain
    # noncurrent versions because persisted records may reference a version ID.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "expire-inbound-receipt-completions"
    status = "Enabled"

    filter {
      prefix = "${local.raw_prefix}completed/"
    }

    # SQS retains messages for at most 14 days. Keep the proof one day longer
    # so every ordinary at-least-once redelivery can be acknowledged safely.
    expiration {
      days = 15
    }
  }
}

data "aws_iam_policy_document" "email_bucket" {
  statement {
    sid       = "AllowSesReceiptStorage"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.email.arn}/${local.raw_prefix}*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "email" {
  bucket = aws_s3_bucket.email.id
  policy = data.aws_iam_policy_document.email_bucket.json
}
