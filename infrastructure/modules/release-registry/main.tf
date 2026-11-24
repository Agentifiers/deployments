locals {
  account_root_arn    = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  bucket_arn          = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket_name}"
  release_objects_arn = "${local.bucket_arn}/releases/*"
  common_tags = merge(
    {
      ManagedBy = "terraform"
      Product   = "deployments-ai-platform"
      Runtime   = "release-registry"
    },
    var.tags,
  )
  github_oidc_provider_arn = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn

  bucket_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      # Lifecycle expiration is not evaluated against bucket policies, so only the lifecycle service can delete.
      {
        Sid       = "DenyObjectDeletion"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${local.bucket_arn}/*"
      },
      {
        Sid       = "DenyUnconditionalObjectWrites"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.bucket_arn}/*"
        Condition = {
          Null = { "s3:if-none-match" = "true" }
          Bool = { "s3:ObjectCreationOperation" = "true" }
        }
      },
      {
        Sid       = "DenyObjectWritesExceptPublisher"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.bucket_arn}/*"
        Condition = {
          ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.publisher.arn }
        }
      },
      # Lifecycle age counts from creation, so a retained object retagged dev would expire at once.
      {
        Sid       = "DenyRetainedObjectRetagging"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource  = "${local.bucket_arn}/*"
        Condition = {
          StringEquals = { "s3:ExistingObjectTag/retention" = "customer" }
        }
      },
      {
        Sid       = "DenyRetentionOtherThanCustomerExceptPublisher"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource  = "${local.bucket_arn}/*"
        Condition = {
          ArnNotEquals    = { "aws:PrincipalArn" = aws_iam_role.publisher.arn }
          StringNotEquals = { "s3:RequestObjectTag/retention" = "customer" }
        }
      },
      {
        Sid       = "RecordsOutlivePayloadExpiry"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource  = ["${local.release_objects_arn}/release-record.json", "${local.release_objects_arn}/release-record.sig.json"]
        Condition = {
          Null = { "s3:RequestObjectTag/object" = "false" }
        }
      },
    ]
  })
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "releases" {
  bucket        = var.bucket_name
  force_destroy = false

  tags = local.common_tags
}

resource "aws_s3_bucket_ownership_controls" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket = aws_s3_bucket.releases.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "releases" {
  bucket = aws_s3_bucket.releases.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    id     = "expire-dev-payloads"
    status = "Enabled"

    filter {
      and {
        tags = {
          object    = "payload"
          retention = "dev"
        }
      }
    }

    expiration {
      days = var.dev_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  rule {
    id     = "remove-expired-delete-markers"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.releases]
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id
  policy = local.bucket_policy

  depends_on = [aws_s3_bucket_public_access_block.releases]
}

resource "aws_kms_key" "signing" {
  description              = "Signs platform release records"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30

  # Without a policy, the default lets any IAM identity with kms:Sign sign records.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AdministerKey"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action = [
          "kms:CancelKeyDeletion",
          "kms:CreateAlias",
          "kms:DeleteAlias",
          "kms:DescribeKey",
          "kms:DisableKey",
          "kms:EnableKey",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListGrants",
          "kms:ListKeyPolicies",
          "kms:ListResourceTags",
          "kms:PutKeyPolicy",
          "kms:RevokeGrant",
          "kms:ScheduleKeyDeletion",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:UpdateAlias",
          "kms:UpdateKeyDescription",
        ]
        Resource = "*"
      },
      {
        Sid       = "ReadPublicKey"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "kms:GetPublicKey"
        Resource  = "*"
      },
      {
        Sid       = "SignReleaseRecords"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.publisher.arn }
        Action    = "kms:Sign"
        Resource  = "*"
      },
    ]
  })

  tags = local.common_tags
}

resource "aws_kms_alias" "signing" {
  name          = var.signing_key_alias
  target_key_id = aws_kms_key.signing.key_id
}

resource "aws_ecr_repository" "deployer" {
  name                 = var.deployer_repository_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.common_tags
}

# Matches the platform image repositories' policy in scripts/platform-deploy/images.ts. Untagged
# entries are index children, which ECR keeps while a tagged index references them.
resource "aws_ecr_lifecycle_policy" "deployer" {
  repository = aws_ecr_repository.deployer.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the newest 30 release images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 30
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire manifests no release index references"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == null ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  tags = local.common_tags
}

resource "aws_iam_role" "publisher" {
  name                 = var.publisher_role_name
  description          = "Publishes platform releases from GitHub Actions"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "GitHubSubject"
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = local.github_oidc_provider_arn
      }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = var.github_subject
        }
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "publish_releases" {
  name = "PublishReleases"
  role = aws_iam_role.publisher.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListReleases"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.bucket_arn
      },
      {
        Sid      = "WriteReleaseObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging"]
        Resource = local.release_objects_arn
      },
      {
        Sid      = "SignReleaseRecords"
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey", "kms:Sign"]
        Resource = aws_kms_key.signing.arn
      },
      {
        Sid      = "AuthenticateToEcr"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PushDeployerImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.deployer.arn
      },
    ]
  })
}

resource "aws_iam_policy" "reader" {
  name        = var.reader_policy_name
  description = "Reads, retains, and verifies platform releases and pulls the deployer image"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListReleases"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.bucket_arn
      },
      {
        Sid      = "ReadAndRetainReleaseObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectTagging", "s3:PutObjectTagging"]
        Resource = local.release_objects_arn
      },
      {
        Sid      = "ReadSigningPublicKey"
        Effect   = "Allow"
        Action   = "kms:GetPublicKey"
        Resource = aws_kms_key.signing.arn
      },
      {
        Sid      = "AuthenticateToEcr"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PullDeployerImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.deployer.arn
      },
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "reader" {
  for_each = toset(var.reader_role_names)

  role       = each.value
  policy_arn = aws_iam_policy.reader.arn
}
