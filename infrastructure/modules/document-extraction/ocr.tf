locals {
  textract_endpoint_count = var.ocr_enabled && var.network != null ? 1 : 0
  textract_endpoint_url   = var.ocr_enabled ? "https://${data.aws_vpc_endpoint_service.textract[0].private_dns_name}" : null
}

data "aws_region" "current" {}

# Also the Region gate: the plan fails where Textract is not offered.
data "aws_vpc_endpoint_service" "textract" {
  count = var.ocr_enabled ? 1 : 0

  service      = "textract"
  service_type = "Interface"
}

resource "aws_security_group" "textract_endpoint" {
  count = local.textract_endpoint_count

  name_prefix = "document-extraction-textract-"
  description = "Textract interface endpoint: HTTPS from document extraction only"
  vpc_id      = var.network.vpc_id

  tags = merge(local.common_tags, { Name = "document-extraction-textract" })
}

resource "aws_vpc_security_group_ingress_rule" "textract_endpoint_from_extraction" {
  count = local.textract_endpoint_count

  security_group_id            = aws_security_group.textract_endpoint[0].id
  referenced_security_group_id = aws_security_group.document_extraction[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "document_extraction_textract" {
  count = local.textract_endpoint_count

  security_group_id            = aws_security_group.document_extraction[0].id
  referenced_security_group_id = aws_security_group.textract_endpoint[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = local.common_tags
}

data "aws_iam_policy_document" "textract_endpoint" {
  count = local.textract_endpoint_count

  statement {
    actions   = ["textract:DetectDocumentText"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.document_extraction.arn]
    }
  }
}

resource "aws_vpc_endpoint" "textract" {
  count = local.textract_endpoint_count

  vpc_id              = var.network.vpc_id
  service_name        = data.aws_vpc_endpoint_service.textract[0].service_name
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = var.network.private_subnet_ids
  security_group_ids  = [aws_security_group.textract_endpoint[0].id]
  policy              = data.aws_iam_policy_document.textract_endpoint[0].json

  tags = merge(local.common_tags, { Name = "document-extraction-textract" })
}
