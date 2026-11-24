locals {
  name = "preview-sites-${var.environment}"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "preview-sites"
    },
    var.tags,
  )
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "sites" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  tags = merge(local.common_tags, { Name = local.name })
}

resource "aws_s3_bucket_ownership_controls" "sites" {
  bucket = aws_s3_bucket.sites.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "sites" {
  bucket = aws_s3_bucket.sites.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sites" {
  bucket = aws_s3_bucket.sites.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "sites" {
  bucket = aws_s3_bucket.sites.id

  rule {
    id     = "expire-previews"
    status = "Enabled"

    filter {}

    expiration {
      days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "sites" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.sites.arn,
      "${aws_s3_bucket.sites.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.sites.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.sites.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "sites" {
  bucket = aws_s3_bucket.sites.id
  policy = data.aws_iam_policy_document.sites.json

  depends_on = [aws_s3_bucket_public_access_block.sites]
}

resource "aws_acm_certificate" "sites" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.common_tags, { Name = var.domain_name })
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.sites.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "sites" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.sites.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_cloudfront_origin_access_control" "sites" {
  name                              = local.name
  description                       = "Signed CloudFront reads of preview site objects"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "directory_index" {
  name    = "${local.name}-directory-index"
  comment = "Serve index.html for directory and extensionless preview paths"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.endsWith("/")) {
        request.uri = uri + "index.html";
      } else if (uri.slice(uri.lastIndexOf("/") + 1).indexOf(".") === -1) {
        request.uri = uri + "/index.html";
      }
      return request;
    }
  JS
}

resource "aws_cloudfront_cache_policy" "sites" {
  name        = local.name
  comment     = "Short-lived preview caching that honors object Cache-Control"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 60

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "sites" {
  name    = local.name
  comment = "Preview site security and no-index headers"

  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      override = true
      value    = "noindex, nofollow"
    }
  }

  security_headers_config {
    content_security_policy {
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      override        = true
      referrer_policy = "strict-origin-when-cross-origin"
    }
  }
}

resource "aws_cloudfront_distribution" "sites" {
  aliases             = [var.domain_name]
  comment             = "Published preview sites"
  default_root_object = "index.html"
  enabled             = true
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.sites.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.sites.id
    origin_id                = "preview-sites"
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.sites.id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.sites.id
    target_origin_id           = "preview-sites"
    viewer_protocol_policy     = "redirect-to-https"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.directory_index.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.sites.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = merge(local.common_tags, { Name = var.domain_name })
}

resource "aws_route53_record" "alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    evaluate_target_health = false
    name                   = aws_cloudfront_distribution.sites.domain_name
    zone_id                = aws_cloudfront_distribution.sites.hosted_zone_id
  }
}

data "aws_iam_policy_document" "publisher" {
  statement {
    sid       = "ListVerticalPreviews"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.sites.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["verticals/*"]
    }
  }

  statement {
    sid       = "WriteVerticalPreviews"
    actions   = ["s3:DeleteObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.sites.arn}/verticals/*"]
  }

  statement {
    sid       = "InvalidatePreviews"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.sites.arn]
  }
}
