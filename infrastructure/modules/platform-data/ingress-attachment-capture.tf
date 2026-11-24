locals {
  ingress_attachment_capture_enabled = length(var.ingress_attachment_capture_principal_arns) > 0
  tenant_input_file_prefix           = "${local.artifact_bucket_arn}/artifacts/organizations/$${aws:PrincipalTag/organizationId}/projects/$${aws:PrincipalTag/projectId}/environments/$${aws:PrincipalTag/environmentId}/customer/*/*"
  tenant_input_file_sources          = "${local.tenant_input_file_prefix}/@input"
  tenant_input_file_texts            = "${local.tenant_input_file_prefix}/text/document-text-v1.txt"
}

data "aws_iam_policy_document" "ingress_attachment_capture_assume" {
  count = local.ingress_attachment_capture_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "AWS"
      identifiers = var.ingress_attachment_capture_principal_arns
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["environmentId", "organizationId", "projectId"]
    }
    dynamic "condition" {
      for_each = toset(["environmentId", "organizationId", "projectId"])
      content {
        test     = "Null"
        variable = "aws:RequestTag/${condition.key}"
        values   = ["false"]
      }
    }
  }
}

resource "aws_iam_role" "ingress_attachment_capture" {
  count = local.ingress_attachment_capture_enabled ? 1 : 0

  name                 = "agent-ingress-attachment-capture"
  assume_role_policy   = data.aws_iam_policy_document.ingress_attachment_capture_assume[0].json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "ingress_attachment_capture" {
  statement {
    sid       = "CaptureTenantInputFiles"
    actions   = ["s3:PutObject"]
    resources = [local.tenant_input_file_sources, local.tenant_input_file_texts]

    condition {
      test     = "StringEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid       = "VerifyTenantInputFiles"
    actions   = ["s3:GetObject"]
    resources = [local.tenant_input_file_sources, local.tenant_input_file_texts]
  }

  # The extraction function fetches the source through a version-pinned presigned GET, which S3 authorizes as GetObjectVersion.
  statement {
    sid       = "PresignTenantInputFileSources"
    actions   = ["s3:GetObjectVersion"]
    resources = [local.tenant_input_file_sources]
  }

  # A checksum HEAD of an SSE-KMS object needs kms:Decrypt. Bucket Keys put the bucket, not the
  # object, in the encryption context, so the S3 resources above are the tenant boundary.
  statement {
    sid       = "EncryptTenantInputFiles"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [local.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"]
    }
  }
}

resource "aws_iam_role_policy" "ingress_attachment_capture" {
  count = local.ingress_attachment_capture_enabled ? 1 : 0

  name   = "capture"
  role   = aws_iam_role.ingress_attachment_capture[0].id
  policy = data.aws_iam_policy_document.ingress_attachment_capture.json
}
