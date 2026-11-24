resource "aws_s3_bucket" "governance_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  bucket              = "governance-${data.aws_caller_identity.current.account_id}"
  force_destroy       = false
  object_lock_enabled = true

  tags = merge(local.common_tags, { Name = "governance" })
}

resource "aws_s3_bucket" "governance_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  bucket              = "governance-${data.aws_caller_identity.current.account_id}"
  force_destroy       = false
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, { Name = "governance" })
}

resource "aws_s3_bucket_ownership_controls" "governance" {
  bucket = local.governance_bucket_id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "governance" {
  bucket = local.governance_bucket_id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "governance" {
  bucket = local.governance_bucket_id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "governance" {
  bucket = local.governance_bucket_id

  depends_on = [aws_s3_bucket_versioning.governance]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "governance" {
  bucket = local.governance_bucket_id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      kms_master_key_id = local.data_kms_key_arn
      sse_algorithm     = "aws:kms"
    }
  }
}

data "aws_iam_policy_document" "governance" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      local.governance_bucket_arn,
      "${local.governance_bucket_arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyWrongGovernanceKmsKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${local.governance_bucket_arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [local.data_kms_key_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "governance" {
  bucket = local.governance_bucket_id
  policy = data.aws_iam_policy_document.governance.json

  depends_on = [aws_s3_bucket_public_access_block.governance]
}

resource "aws_kms_key" "governance_signing_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  description              = "Asymmetric signing key for immutable governance export manifests"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = var.kms_deletion_window_in_days
  enable_key_rotation      = false

  tags = merge(local.common_tags, { Name = "governance-export-signing" })
}

resource "aws_kms_key" "governance_signing_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  description              = "Asymmetric signing key for immutable governance export manifests"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = var.kms_deletion_window_in_days
  enable_key_rotation      = false

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, { Name = "governance-export-signing" })
}

resource "aws_kms_alias" "governance_signing" {
  name          = "alias/governance-signing"
  target_key_id = local.governance_signing_key_id
}
