locals {
  agent_worker_service_name     = "agent-worker"
  agent_worker_metric_namespace = "DeploymentsAI/AgentWorker"
  tenant_limit_metric_namespace = "DeploymentsAi/TenantLimits"
  # ECS stops a task this long after SIGTERM (the Fargate maximum, matching the two-minute
  # Fargate Spot interruption notice); the host drains within the shorter drain timeout so
  # shutdown-interrupted runs are requeued before SIGKILL.
  agent_worker_stop_timeout_seconds  = 120
  agent_worker_drain_timeout_seconds = 100
  ecs_cluster_name                   = element(split("/", var.ecs_cluster_arn), 1)
  agent_worker_container_environment = merge(local.agent_worker_environment, {
    for name, value in var.runtime_environment_variables : name => value
    if contains(local.agent_worker_container_only_environment_names, name)
    }, {
    DEPLOYMENTS_AI_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS = tostring(local.agent_worker_drain_timeout_seconds)
    DEPLOYMENTS_AI_AGENT_WORKER_MAX_CONCURRENT_RUNS   = tostring(var.worker_max_concurrent_runs)
    DEPLOYMENTS_AI_AGENT_WORKER_METRIC_NAMESPACE      = local.agent_worker_metric_namespace
    DEPLOYMENTS_AI_AGENT_WORKER_SERVICE_NAME          = local.agent_worker_service_name
    DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS         = join(",", var.model_token_service_fallback_models)
  })
  agent_worker_secret_parameter_arns = concat([
    var.durable_streams_auth_secret_arn,
    var.model_grants_parameter_arn,
  ], [for arn in var.runtime_secret_arns : arn if strcontains(arn, ":ssm:")])
  agent_worker_secrets_manager_arns = [
    for arn in var.runtime_secret_arns : arn if strcontains(arn, ":secretsmanager:")
  ]
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "agent_worker" {
  name              = "/ecs/${local.agent_worker_service_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "agent_worker_execution" {
  name                 = "${local.agent_worker_service_name}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "agent_worker_execution" {
  role       = aws_iam_role.agent_worker_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "agent_worker_task" {
  name                 = "${local.agent_worker_service_name}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "agent_worker_task" {
  statement {
    sid = "RunQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.runs.arn]
  }

  statement {
    sid = "PlatformTables"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = concat(
      values(var.dynamodb_table_arns),
      [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
    )
  }

  statement {
    sid = "MessageBodies"
    actions = [
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = flatten([
      for bucket_arn in concat([var.artifact_bucket_arn], var.legacy_artifact_bucket_arns) : [
        "${bucket_arn}/artifacts/*",
        "${bucket_arn}/memory/*",
        "${bucket_arn}/message-bodies/*",
        "${bucket_arn}/organizations/*",
      ]
    ])
  }

  statement {
    sid       = "BrowserSessionIdempotency"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.artifact_bucket_arn}/browser-session-idempotency/*"]
  }

  statement {
    sid       = "ArtifactBucket"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketVersions"]
    resources = concat([var.artifact_bucket_arn], var.legacy_artifact_bucket_arns)
  }

  # Artifact objects are SSE-KMS under the shared key; S3 uses it on the caller's behalf.
  statement {
    sid       = "ArtifactObjectEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"]
    }
  }

  # The credential vault is the only direct KMS API consumer.
  statement {
    sid       = "ProtectCredentials"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["credentialId", "environmentId", "organizationId", "ownerId", "ownerType", "projectId", "purpose"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:credentialId"
      values   = ["false"]
    }
  }

  statement {
    sid       = "RuntimeParameters"
    actions   = ["ssm:GetParameter"]
    resources = local.agent_worker_secret_parameter_arns
  }

  dynamic "statement" {
    for_each = length(local.agent_worker_secrets_manager_arns) == 0 ? [] : [1]
    content {
      sid       = "RuntimeSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.agent_worker_secrets_manager_arns
    }
  }

  statement {
    sid = "AutomationSchedules"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "scheduler:UpdateSchedule",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/${aws_scheduler_schedule_group.runtime.name}/*"]
  }

  statement {
    sid       = "PassSchedulerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]
  }

  dynamic "statement" {
    for_each = trimspace(var.oauth_refresh_function_arn) == "" ? [] : [1]
    content {
      sid       = "InvokeOAuthRefresh"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.oauth_refresh_function_arn]
    }
  }

  # The worker mints run tokens and agent-worker service tokens; it never holds kms:Sign itself.
  statement {
    sid     = "InvokeModelTokenIssuers"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.model_token_issuer["agent-worker"].arn,
      aws_lambda_function.model_token_issuer["run"].arn,
    ]
  }

  statement {
    sid       = "WorkerMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.agent_worker_metric_namespace, local.tenant_limit_metric_namespace]
    }
  }
}

resource "aws_iam_role_policy" "agent_worker_task" {
  name   = "${local.agent_worker_service_name}-runtime"
  role   = aws_iam_role.agent_worker_task.id
  policy = data.aws_iam_policy_document.agent_worker_task.json
}

resource "aws_iam_role_policy_attachment" "agent_worker_runtime" {
  for_each = var.runtime_policy_arns

  role       = aws_iam_role.agent_worker_task.name
  policy_arn = each.value
}

resource "aws_ecs_task_definition" "agent_worker" {
  family                   = local.agent_worker_service_name
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.agent_worker_execution.arn
  task_role_arn            = aws_iam_role.agent_worker_task.arn

  container_definitions = jsonencode([{
    name        = local.agent_worker_service_name
    image       = var.agent_worker_image
    essential   = true
    stopTimeout = local.agent_worker_stop_timeout_seconds
    environment = [
      for name in sort(keys(local.agent_worker_container_environment)) : {
        name  = name
        value = local.agent_worker_container_environment[name]
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.agent_worker.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "agent_worker" {
  name            = local.agent_worker_service_name
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.agent_worker.arn
  # Initial size only; Application Auto Scaling owns desired_count afterwards.
  desired_count = var.worker_min_count
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  # Rollouts keep full run capacity: new tasks start before old tasks drain.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  # The deploy tool verifies the rollout instead: a circuit-breaker rollback
  # reaches steady state too, so this waiter cannot detect a failed release.
  wait_for_steady_state = false
  propagate_tags        = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = concat([aws_security_group.worker.id], var.worker_additional_security_group_ids)
    subnets          = var.private_subnet_ids
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_iam_role_policy.agent_worker_task,
    aws_iam_role_policy_attachment.agent_worker_execution,
    aws_iam_role_policy_attachment.agent_worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_appautoscaling_target" "agent_worker" {
  min_capacity       = var.worker_min_count
  max_capacity       = var.worker_max_count
  resource_id        = "service/${local.ecs_cluster_name}/${aws_ecs_service.agent_worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
  tags               = local.common_tags

  lifecycle {
    precondition {
      condition     = var.worker_min_count <= var.worker_max_count
      error_message = "worker_min_count must not exceed worker_max_count."
    }
  }
}

# Each task reports inFlightRuns / maxConcurrentRuns every minute; tracking the
# fleet average at 60 percent keeps free run slots for bursts.
resource "aws_appautoscaling_policy" "agent_worker_run_slots" {
  name               = "${local.agent_worker_service_name}-run-slot-utilization"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.agent_worker.resource_id
  scalable_dimension = aws_appautoscaling_target.agent_worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.agent_worker.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_out_cooldown = 60
    # Scale-in stops tasks that must drain in-flight runs; wait out short lulls.
    scale_in_cooldown = 600

    customized_metric_specification {
      metric_name = "RunSlotUtilization"
      namespace   = local.agent_worker_metric_namespace
      statistic   = "Average"
      unit        = "Percent"

      dimensions {
        name  = "ServiceName"
        value = local.agent_worker_service_name
      }
    }
  }
}
