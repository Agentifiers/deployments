locals {
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
    },
    var.tags,
  )

  data_kms_key_arn = one(concat(
    aws_kms_key.data_unprotected[*].arn,
    aws_kms_key.data_protected[*].arn,
  ))
  data_kms_key_id = one(concat(
    aws_kms_key.data_unprotected[*].key_id,
    aws_kms_key.data_protected[*].key_id,
  ))
  artifact_bucket_arn = one(concat(
    aws_s3_bucket.artifacts_unprotected[*].arn,
    aws_s3_bucket.artifacts_protected[*].arn,
  ))
  artifact_bucket_id = one(concat(
    aws_s3_bucket.artifacts_unprotected[*].id,
    aws_s3_bucket.artifacts_protected[*].id,
  ))
  governance_bucket_arn = one(concat(
    aws_s3_bucket.governance_unprotected[*].arn,
    aws_s3_bucket.governance_protected[*].arn,
  ))
  governance_bucket_id = one(concat(
    aws_s3_bucket.governance_unprotected[*].id,
    aws_s3_bucket.governance_protected[*].id,
  ))
  governance_signing_key_arn = one(concat(
    aws_kms_key.governance_signing_unprotected[*].arn,
    aws_kms_key.governance_signing_protected[*].arn,
  ))
  governance_signing_key_id = one(concat(
    aws_kms_key.governance_signing_unprotected[*].key_id,
    aws_kms_key.governance_signing_protected[*].key_id,
  ))

  semantic_event_columns = [
    { name = "event_id", type = "string" },
    { name = "event_type", type = "string" },
    { name = "event_source", type = "string" },
    { name = "event_entity", type = "string" },
    { name = "event_action", type = "string" },
    { name = "eventbridge_event_id", type = "string" },
    { name = "eventbridge_detail_type", type = "string" },
    { name = "aws_account_id", type = "string" },
    { name = "aws_region", type = "string" },
    { name = "organization_id", type = "string" },
    { name = "project_id", type = "string" },
    { name = "environment_id", type = "string" },
    { name = "aggregate_type", type = "string" },
    { name = "aggregate_id", type = "string" },
    { name = "aggregate_version", type = "long" },
    { name = "actor_id", type = "string" },
    { name = "actor_type", type = "string" },
    { name = "trace_id", type = "string" },
    { name = "occurred_at", type = "string" },
    { name = "ingested_at", type = "string" },
    { name = "payload_json", type = "string" },
  ]
  semantic_event_table_arn = one(concat(
    aws_s3tables_table.semantic_events_unprotected[*].arn,
    aws_s3tables_table.semantic_events_protected[*].arn,
  ))
  semantic_event_table_name = one(concat(
    aws_s3tables_table.semantic_events_unprotected[*].name,
    aws_s3tables_table.semantic_events_protected[*].name,
  ))
  s3tables_catalog_arn = one(concat(
    aws_glue_catalog.s3tables_unprotected[*].arn,
    aws_glue_catalog.s3tables_protected[*].arn,
  ))

  global_secondary_indexes = {
    gsi1 = {
      hash_key  = "gsi1pk"
      range_key = "gsi1sk"
    }
    gsi2 = {
      hash_key  = "gsi2pk"
      range_key = "gsi2sk"
    }
  }

  tables = {
    control = {
      stream_enabled           = false
      global_secondary_indexes = local.global_secondary_indexes
    }
    execution = {
      stream_enabled           = true
      global_secondary_indexes = local.global_secondary_indexes
    }
    events = {
      stream_enabled           = true
      global_secondary_indexes = local.global_secondary_indexes
    }
    identity = {
      stream_enabled           = false
      global_secondary_indexes = { gsi1 = local.global_secondary_indexes.gsi1 }
    }
    identity-email-outbox = {
      stream_enabled           = true
      global_secondary_indexes = { gsi1 = local.global_secondary_indexes.gsi1 }
    }
    usage = {
      stream_enabled           = true
      global_secondary_indexes = local.global_secondary_indexes
    }
  }

  throttle_operations = toset([
    "BatchGetItem",
    "BatchWriteItem",
    "DeleteItem",
    "GetItem",
    "PutItem",
    "Query",
    "TransactGetItems",
    "TransactWriteItems",
    "UpdateItem",
  ])

  throttle_alarms = merge([
    for table_name in keys(local.tables) : {
      for operation in local.throttle_operations :
      "${table_name}-${operation}" => {
        operation = operation
        table     = table_name
      }
    }
  ]...)
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

resource "aws_s3tables_table_bucket" "semantic_events" {
  name          = "semantic-events"
  force_destroy = !var.deletion_protection_enabled
  encryption_configuration = {
    sse_algorithm = "AES256"
    kms_key_arn   = null
  }
  tags = merge(local.common_tags, { Name = "semantic-events" })
}

resource "aws_s3tables_namespace" "semantic_events" {
  namespace        = "semantic_events"
  table_bucket_arn = aws_s3tables_table_bucket.semantic_events.arn
}

resource "aws_s3tables_table" "semantic_events_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  name             = "events"
  namespace        = aws_s3tables_namespace.semantic_events.namespace
  table_bucket_arn = aws_s3tables_table_bucket.semantic_events.arn
  format           = "ICEBERG"

  metadata {
    iceberg {
      schema {
        dynamic "field" {
          for_each = local.semantic_event_columns
          content {
            name     = field.value.name
            type     = field.value.type
            required = false
          }
        }
      }
    }
  }

  tags = merge(local.common_tags, { Name = "semantic-events" })
}

resource "aws_s3tables_table" "semantic_events_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  name             = "events"
  namespace        = aws_s3tables_namespace.semantic_events.namespace
  table_bucket_arn = aws_s3tables_table_bucket.semantic_events.arn
  format           = "ICEBERG"

  metadata {
    iceberg {
      schema {
        dynamic "field" {
          for_each = local.semantic_event_columns
          content {
            name     = field.value.name
            type     = field.value.type
            required = false
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, { Name = "semantic-events" })
}

resource "aws_glue_catalog" "s3tables_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  name        = "s3tablescatalog"
  description = "Account-level integration that mounts S3 table buckets in the Glue Data Catalog."

  federated_catalog {
    connection_name = "aws:s3tables"
    identifier      = "arn:aws:s3tables:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:bucket/*"
  }

  create_database_default_permissions {
    permissions = ["ALL"]
    principal {
      data_lake_principal_identifier = "IAM_ALLOWED_PRINCIPALS"
    }
  }

  create_table_default_permissions {
    permissions = ["ALL"]
    principal {
      data_lake_principal_identifier = "IAM_ALLOWED_PRINCIPALS"
    }
  }

  tags = merge(local.common_tags, { Name = "s3tablescatalog" })
}

resource "aws_glue_catalog" "s3tables_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  name        = "s3tablescatalog"
  description = "Account-level integration that mounts S3 table buckets in the Glue Data Catalog."

  federated_catalog {
    connection_name = "aws:s3tables"
    identifier      = "arn:aws:s3tables:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:bucket/*"
  }

  create_database_default_permissions {
    permissions = ["ALL"]
    principal {
      data_lake_principal_identifier = "IAM_ALLOWED_PRINCIPALS"
    }
  }

  create_table_default_permissions {
    permissions = ["ALL"]
    principal {
      data_lake_principal_identifier = "IAM_ALLOWED_PRINCIPALS"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, { Name = "s3tablescatalog" })
}

# The single shared symmetric customer managed key, formerly the artifact key. It encrypts artifact,
# governance, and content objects (SSE-KMS), application envelope ciphertexts (cursors, idempotency
# responses, credentials, identity secrets), and SNS topics whose AWS service publishers cannot use
# AWS managed keys. Every other store uses AWS owned or managed keys.
data "aws_iam_policy_document" "data_kms" {
  statement {
    sid       = "AccountIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # Services that publish to SNS topics encrypted with this key, bound to those topics.
  dynamic "statement" {
    for_each = var.sns_service_publishers
    content {
      sid       = statement.key
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = [statement.value.service]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:aws:sns:topicArn"
        values = [
          for name in statement.value.topic_names :
          "arn:${data.aws_partition.current.partition}:sns:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${name}"
        ]
      }
    }
  }
}

resource "aws_kms_key" "data_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  description             = "Deployments.ai platform ${var.environment} application data and artifact encryption"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.data_kms.json

  tags = merge(local.common_tags, {
    Name = "platform-data"
  })
}

resource "aws_kms_key" "data_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  description             = "Deployments.ai platform ${var.environment} application data and artifact encryption"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.data_kms.json

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, {
    Name = "platform-data"
  })
}

resource "aws_kms_alias" "data" {
  name          = "alias/platform-data"
  target_key_id = local.data_kms_key_id
}

resource "aws_s3_bucket" "artifacts_unprotected" {
  count = var.deletion_protection_enabled ? 0 : 1

  bucket        = "artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = merge(local.common_tags, {
    Name = "artifacts"
  })
}

resource "aws_s3_bucket" "artifacts_protected" {
  count = var.deletion_protection_enabled ? 1 : 0

  bucket        = "artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, {
    Name = "artifacts"
  })
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = local.artifact_bucket_id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = local.artifact_bucket_id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "artifacts" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      local.artifact_bucket_arn,
      "${local.artifact_bucket_arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyNonKmsObjectEncryption"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${local.artifact_bucket_arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyWrongArtifactKmsKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${local.artifact_bucket_arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [local.data_kms_key_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = local.artifact_bucket_id
  policy = data.aws_iam_policy_document.artifacts.json

  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = local.artifact_bucket_id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      kms_master_key_id = local.data_kms_key_arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = local.artifact_bucket_id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = local.artifact_bucket_id

  cors_rule {
    allowed_headers = [
      "content-length",
      "content-type",
      "if-none-match",
      "x-amz-checksum-sha256",
      "x-amz-server-side-encryption",
      "x-amz-server-side-encryption-aws-kms-key-id",
    ]
    allowed_methods = ["PUT"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag", "x-amz-version-id"]
    max_age_seconds = 900
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = local.artifact_bucket_id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-browser-session-idempotency"
    status = "Enabled"

    filter {
      prefix = "browser-session-idempotency/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}
