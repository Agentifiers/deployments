locals {
  # Static asset prefixes served from S3; every other path reaches the console server. The deploy
  # tool uploads the release's static assets to the bucket root, so object keys equal URL paths.
  static_path_patterns = ["/assets/*"]
  certificate_managed  = trimspace(var.certificate_arn) == "" && trimspace(var.route53_zone_id) != ""
  certificate_arn      = local.certificate_managed ? aws_acm_certificate_validation.console[0].certificate_arn : var.certificate_arn
  api_origin_id        = "console-server"
  assets_origin_id     = "console-assets"
}

resource "aws_s3_bucket" "assets" {
  bucket        = "console-assets-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.deletion_protection_enabled
  tags          = merge(local.tags, { Name = "console-assets" })
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket = aws_s3_bucket.assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "assets" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.assets.arn,
      "${aws_s3_bucket.assets.arn}/*",
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
    resources = ["${aws_s3_bucket.assets.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.console.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.assets.json

  depends_on = [aws_s3_bucket_public_access_block.assets]
}

resource "aws_acm_certificate" "console" {
  count    = local.certificate_managed ? 1 : 0
  provider = aws.us_east_1

  domain_name       = local.domain_name
  validation_method = "DNS"
  tags              = merge(local.tags, { Name = local.domain_name })

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.certificate_managed ? {
    for option in aws_acm_certificate.console[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "console" {
  count    = local.certificate_managed ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.console[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "console-assets"
  description                       = "Signed CloudFront reads of console static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "console" {
  aliases         = [local.domain_name]
  comment         = "Management console"
  enabled         = true
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    domain_name = trimprefix(aws_apigatewayv2_api.console.api_endpoint, "https://")
    origin_id   = local.api_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
    origin_id                = local.assets_origin_id
  }

  # The server renders per-session HTML and handles auth and server-function requests, so it is
  # never cached and receives every viewer header except Host (the HTTP API requires its own).
  default_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    compress                   = true
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    target_origin_id           = local.api_origin_id
    viewer_protocol_policy     = "redirect-to-https"
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.static_path_patterns

    content {
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
      compress                   = true
      path_pattern               = ordered_cache_behavior.value
      response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
      target_origin_id           = local.assets_origin_id
      viewer_protocol_policy     = "redirect-to-https"
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  lifecycle {
    precondition {
      condition     = local.certificate_arn != ""
      error_message = "The console requires certificate_arn or a Route 53 zone for a managed us-east-1 certificate."
    }
  }

  tags = merge(local.tags, { Name = local.domain_name })
}

resource "aws_route53_record" "alias" {
  for_each = trimspace(var.route53_zone_id) == "" ? toset([]) : toset(["A", "AAAA"])

  zone_id = var.route53_zone_id
  name    = local.domain_name
  type    = each.key

  alias {
    evaluate_target_health = false
    name                   = aws_cloudfront_distribution.console.domain_name
    zone_id                = aws_cloudfront_distribution.console.hosted_zone_id
  }
}
