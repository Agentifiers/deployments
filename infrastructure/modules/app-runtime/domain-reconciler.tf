locals {
  distribution_tenants = "arn:${data.aws_partition.current.partition}:cloudfront::${data.aws_caller_identity.current.account_id}:distribution-tenant/*"
  # CloudFront requests a tenant's managed certificate in us-east-1, whatever the platform region.
  tenant_certificates = "arn:${data.aws_partition.current.partition}:acm:us-east-1:${data.aws_caller_identity.current.account_id}:certificate/*"
}

resource "aws_cloudwatch_log_group" "domain_reconciler" {
  name              = "/aws/lambda/apps-domains"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "domain_reconciler" {
  name                 = "apps-domains"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "domain_reconciler" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.domain_reconciler.arn}:*"]
  }

  statement {
    sid       = "GetAppDomainRecords"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#*#APP#*", "UNIQUE#app-id"]
    }
  }

  statement {
    sid       = "QueryPublishedAppDomains"
    actions   = ["dynamodb:Query"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["UNIQUE#app-hostname"]
    }
  }

  statement {
    sid       = "WriteAppDomainRecords"
    actions   = ["dynamodb:PutItem", "dynamodb:TransactWriteItems"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#*#APP#*", "ORG#*#GOVERNANCE-INVENTORY", "ORG#*#GOVERNANCE-INVENTORY#SHARD#*"]
    }
  }

  # Writers read the shard-writes marker before placing governance inventory locators.
  statement {
    sid       = "ReadGovernanceInventoryLayout"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["GLOBAL#deploy-migration"]
    }
  }

  # A semantic event's item TTL comes from its organization's retention policy, read from the
  # organization partition `ORG#<ULID>`; the 26 wildcards match no deeper partition.
  statement {
    sid       = "ReadOrganizationRetentionPolicy"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#??????????????????????????"]
    }
  }

  # A domain write condition-checks the app, the organization and its erasure fence, and the
  # domain's unchanged unique claims in the same transaction.
  statement {
    sid       = "CheckAppDomainWriteConditions"
    actions   = ["dynamodb:ConditionCheckItem"]
    resources = [var.control_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values = [
        "ORG#*",
        "UNIQUE#app%3A*%3Adomain-hostname",
        "UNIQUE#app%3A*%3Adomain-slot",
        "UNIQUE#app-hostname",
        "UNIQUE#organization%3A*%3Aapp-domain-slot",
      ]
    }
  }

  statement {
    sid       = "AppendAppDomainEvents"
    actions   = ["dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
    resources = [var.events_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#*#AGGREGATE#app-domain#*"]
    }
  }

  # Daily certificate request counters: one per organization and one for the platform.
  statement {
    sid       = "SpendCertificateRequestBudgets"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
    resources = [var.usage_table.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["SCOPE#*"]
    }
  }

  # Reads are not tag-scoped: the reconciler must see untagged tenants to report a hostname that
  # another tenant already serves, and must read tags before it knows a tenant is its own.
  statement {
    sid       = "ListDistributionTenants"
    actions   = ["cloudfront:ListDistributionTenants"]
    resources = ["*"]
  }

  statement {
    sid = "ReadDistributionTenants"
    actions = [
      "cloudfront:GetDistributionTenant",
      "cloudfront:GetDistributionTenantByDomain",
      "cloudfront:GetManagedCertificateDetails",
      "cloudfront:ListTagsForResource",
    ]
    resources = [local.distribution_tenants]
  }

  statement {
    sid       = "CreateManagedTenants"
    actions   = ["cloudfront:CreateDistributionTenant"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/deployments:managed-by"
      values   = ["apps"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["deployments:managed-by"]
    }
  }

  statement {
    sid       = "TagManagedTenantsOnCreate"
    actions   = ["cloudfront:TagResource"]
    resources = [local.distribution_tenants]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/deployments:managed-by"
      values   = ["apps"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["deployments:managed-by"]
    }
  }

  statement {
    sid       = "ChangeManagedTenants"
    actions   = ["cloudfront:DeleteDistributionTenant", "cloudfront:UpdateDistributionTenant"]
    resources = [local.distribution_tenants]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/deployments:managed-by"
      values   = ["apps"]
    }
  }

  # CloudFront checks that a caller creating or updating a tenant may read its VPC origin.
  statement {
    sid       = "ReadGatewayVpcOrigin"
    actions   = ["cloudfront:GetVpcOrigin"]
    resources = [aws_cloudfront_vpc_origin.gateway.arn]
  }

  statement {
    sid       = "ListCertificates"
    actions   = ["acm:ListCertificates"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadTenantCertificates"
    actions   = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"]
    resources = [local.tenant_certificates]
  }

  # CloudFront requests a tenant's managed certificate with the caller's credentials and no tags.
  statement {
    sid       = "RequestTenantCertificates"
    actions   = ["acm:RequestCertificate"]
    resources = ["*"]
  }

  statement {
    sid       = "TagTenantCertificates"
    actions   = ["acm:AddTagsToCertificate"]
    resources = [local.tenant_certificates]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/deployments:managed-by"
      values   = ["apps"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["deployments:managed-by"]
    }
  }

  statement {
    sid       = "DeleteManagedCertificates"
    actions   = ["acm:DeleteCertificate"]
    resources = [local.tenant_certificates]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/deployments:managed-by"
      values   = ["apps"]
    }
  }
}

resource "aws_iam_role_policy" "domain_reconciler" {
  name   = "apps-domains"
  role   = aws_iam_role.domain_reconciler.id
  policy = data.aws_iam_policy_document.domain_reconciler.json
}

resource "aws_lambda_function" "domain_reconciler" {
  function_name     = "apps-domains"
  description       = "Converges CloudFront distribution tenants and their managed certificates to app domain records."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 512
  role              = aws_iam_role.domain_reconciler.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.domain_reconciler_artifact.bucket
  s3_key            = var.domain_reconciler_artifact.key
  s3_object_version = var.domain_reconciler_artifact.version
  timeout           = 300

  # The only writer of tenants and certificates: runs never overlap, and Lambda keeps throttled
  # Event invocations from the scheduler and the API queued until the running one ends.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      APPS_CUSTOM_DOMAIN_CONNECTION_GROUP_ID                    = aws_cloudfront_connection_group.custom_domains.id
      APPS_CUSTOM_DOMAIN_DISTRIBUTION_ID                        = aws_cloudfront_multitenant_distribution.custom_domains.id
      APPS_DOMAIN_CERTIFICATE_REQUESTS_PER_DAY                  = var.domain_certificate_requests_per_day
      APPS_DOMAIN_CERTIFICATE_REQUESTS_PER_ORGANIZATION_PER_DAY = var.domain_certificate_requests_per_organization_per_day
      DEPLOYMENTS_AI_CONTROL_TABLE                              = var.control_table.name
      DEPLOYMENTS_AI_EVENTS_TABLE                               = var.events_table.name
      DEPLOYMENTS_AI_USAGE_TABLE                                = var.usage_table.name
    }
  }

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.domain_reconciler,
    aws_iam_role_policy.domain_reconciler,
  ]
}

# The schedule is the retry: a failed run is not retried, and a queued event the next sweep has
# superseded is dropped, so a failing sweep cannot hold the only slot for refreshes and detaches.
resource "aws_lambda_function_event_invoke_config" "domain_reconciler" {
  function_name                = aws_lambda_function.domain_reconciler.function_name
  maximum_event_age_in_seconds = 600
  maximum_retry_attempts       = 0
}

resource "aws_sqs_queue" "domain_reconciler_schedule_dlq" {
  name                      = "apps-domains-schedule-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "domain_reconciler_scheduler" {
  name                 = "apps-domains-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "domain_reconciler_scheduler" {
  statement {
    sid       = "InvokeAppsDomains"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.domain_reconciler.arn]
  }

  statement {
    sid       = "DeadLetterUndeliveredSweeps"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.domain_reconciler_schedule_dlq.arn]
  }
}

resource "aws_iam_role_policy" "domain_reconciler_scheduler" {
  name   = "apps-domains-scheduler"
  role   = aws_iam_role.domain_reconciler_scheduler.id
  policy = data.aws_iam_policy_document.domain_reconciler_scheduler.json
}

resource "aws_scheduler_schedule" "domain_reconciler" {
  name                = "apps-domains"
  schedule_expression = "rate(5 minutes)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.domain_reconciler.arn
    role_arn = aws_iam_role.domain_reconciler_scheduler.arn
    input    = jsonencode({ kind = "sweep" })

    dead_letter_config {
      arn = aws_sqs_queue.domain_reconciler_schedule_dlq.arn
    }

    # The next sweep supersedes an undelivered one, so retries stop before it fires.
    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 2
    }
  }

  depends_on = [aws_iam_role_policy.domain_reconciler_scheduler]
}

resource "aws_cloudwatch_metric_alarm" "domain_reconciler_errors" {
  alarm_name          = "apps-domains-errors"
  alarm_description   = "The apps-domains Lambda failed in at least two of the last three 5-minute periods."
  comparison_operator = "GreaterThanThreshold"
  datapoints_to_alarm = 2
  evaluation_periods  = 3
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.domain_reconciler.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "domain_reconciler_schedule_dlq" {
  alarm_name          = "apps-domains-schedule-dlq-visible"
  alarm_description   = "The apps-domains schedule could not deliver a sweep; its dead-letter queue holds the event."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    QueueName = aws_sqs_queue.domain_reconciler_schedule_dlq.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "domain_reconciler_deferred_steps" {
  alarm_name          = "apps-domains-deferred-steps"
  alarm_description   = "Every apps-domains sweep in the last three 5-minute periods ran out of time and left steps for the next one; the steps at the end of each sweep are not running."
  comparison_operator = "GreaterThanThreshold"
  datapoints_to_alarm = 3
  evaluation_periods  = 3
  metric_name         = "DeferredReconcileSteps"
  namespace           = "DeploymentsAI/Apps"
  period              = 300
  statistic           = "Minimum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# An organization that spends its own budget sees a domain problem; only the platform budget,
# which holds back every organization, pages.
resource "aws_cloudwatch_metric_alarm" "domain_reconciler_platform_certificate_budget" {
  alarm_name          = "apps-domains-platform-certificate-budget-refused"
  alarm_description   = "The platform's daily certificate request budget held back at least one app domain's certificate; see the domains whose problem is platform_certificate_limit."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "PlatformCertificateBudgetRefusedDomains"
  namespace           = "DeploymentsAI/Apps"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
