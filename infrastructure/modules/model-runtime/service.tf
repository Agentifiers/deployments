locals {
  gateway_port = 8080
  bifrost_port = 8081
  runtime_dir  = "/run/model-gateway"

  runtime_volume_name = "model-gateway-runtime"

  log_configuration = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.gateway.name
      awslogs-region        = data.aws_region.current.region
      awslogs-stream-prefix = "ecs"
    }
  }

  # Renders Bifrost's config.json and generates the internal virtual key on the task-local volume.
  bifrost_config_container = {
    name      = "bifrost-config"
    image     = var.model_gateway_image
    essential = false
    user      = "0"
    command   = ["bun", "/app/render-bifrost-config.js"]
    environment = concat(
      [
        { name = "MODEL_GATEWAY_BIFROST_RUNTIME_DIR", value = local.runtime_dir },
        { name = "MODEL_GATEWAY_HOSTED_PROVIDERS", value = join(",", sort(tolist(var.hosted_providers))) },
      ],
      local.bedrock_hosted ? [
        { name = "MODEL_GATEWAY_BEDROCK_REGION", value = data.aws_region.current.region },
      ] : [],
      var.openai_base_url == "" ? [] : [
        { name = "MODEL_GATEWAY_OPENAI_BASE_URL", value = var.openai_base_url },
      ],
    )
    secrets      = []
    portMappings = []
    mountPoints = [{
      sourceVolume  = local.runtime_volume_name
      containerPath = local.runtime_dir
      readOnly      = false
    }]
    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, { awslogs-stream-prefix = "bifrost-config" })
    })
  }

  # Bifrost keeps its config store in task-local SQLite and listens only on the task loopback.
  bifrost_container = {
    name       = "bifrost"
    image      = var.bifrost_image
    essential  = true
    entryPoint = ["/bin/sh", "-c"]
    command = [
      "mkdir -p /app/data && cp ${local.runtime_dir}/config.json /app/data/config.json && exec /app/docker-entrypoint.sh /app/main",
    ]
    environment = [
      { name = "APP_HOST", value = "127.0.0.1" },
      { name = "APP_PORT", value = tostring(local.bifrost_port) },
      { name = "LOG_LEVEL", value = "info" },
      { name = "LOG_STYLE", value = "json" },
    ]
    secrets = concat(
      contains(var.hosted_providers, "openai") ? [{
        name      = "OPENAI_API_KEY"
        valueFrom = aws_ssm_parameter.runtime["openai-api-key"].arn
      }] : [],
      contains(var.hosted_providers, "openrouter") ? [{
        name      = "OPENROUTER_API_KEY"
        valueFrom = aws_ssm_parameter.runtime["openrouter-api-key"].arn
      }] : [],
    )
    portMappings = []
    mountPoints = [{
      sourceVolume  = local.runtime_volume_name
      containerPath = local.runtime_dir
      readOnly      = true
    }]
    dependsOn = [{
      containerName = "bifrost-config"
      condition     = "SUCCESS"
    }]
    # The pinned image ships BusyBox wget; keep its compatible flags.
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${local.bifrost_port}/health || exit 1"]
      interval    = 30
      retries     = 3
      startPeriod = 60
      timeout     = 5
    }
    stopTimeout = 120
    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, { awslogs-stream-prefix = "bifrost" })
    })
  }

  # Authenticates callers' tokens and forwards admitted requests to Bifrost with the internal key.
  gateway_container = {
    name      = "model-gateway"
    image     = var.model_gateway_image
    essential = true
    environment = concat([
      { name = "DEPLOYMENTS_AI_CONTROL_TABLE", value = var.control_table_name },
      { name = "DEPLOYMENTS_AI_EXECUTION_TABLE", value = var.execution_table_name },
      { name = "DEPLOYMENTS_AI_USAGE_TABLE", value = var.usage_table_name },
      { name = "MODEL_GATEWAY_BIFROST_URL", value = "http://127.0.0.1:${local.bifrost_port}" },
      { name = "MODEL_GATEWAY_BIFROST_VIRTUAL_KEY_FILE", value = "${local.runtime_dir}/bifrost-virtual-key" },
      { name = "MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS", value = join(",", local.trusted_signing_key_arns) },
      { name = "PORT", value = tostring(local.gateway_port) },
      ], var.default_model_spend_ceiling_usd_micros == null ? [] : [
      { name = "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS", value = tostring(var.default_model_spend_ceiling_usd_micros) },
      ], var.model_credentials == null ? [] : [
      { name = "DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN", value = var.model_credentials.kms_key_arn },
      { name = "DEPLOYMENTS_AI_STAGE", value = var.environment },
    ])
    secrets = []
    portMappings = [{
      containerPort = local.gateway_port
      hostPort      = local.gateway_port
      protocol      = "tcp"
    }]
    mountPoints = [{
      sourceVolume  = local.runtime_volume_name
      containerPath = local.runtime_dir
      readOnly      = true
    }]
    dependsOn = [{
      containerName = "bifrost"
      condition     = "HEALTHY"
    }]
    # The slim Bun image has no curl or wget.
    healthCheck = {
      command = [
        "CMD",
        "bun",
        "-e",
        "fetch('http://127.0.0.1:${local.gateway_port}/livez').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
      ]
      interval    = 30
      retries     = 3
      startPeriod = 15
      timeout     = 5
    }
    stopTimeout = 120
    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, { awslogs-stream-prefix = "model-gateway" })
    })
  }
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${local.name_prefix}-gateway"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${local.name_prefix}-gateway"
  cpu                      = var.compact_task_sizing_enabled ? "512" : "1024"
  memory                   = var.compact_task_sizing_enabled ? "1024" : "2048"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    local.bifrost_config_container,
    local.bifrost_container,
    local.gateway_container,
  ])

  # Task-local bind volume: the rendered config and internal key never leave the task.
  volume {
    name = local.runtime_volume_name
  }

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "gateway" {
  name                  = "${local.name_prefix}-gateway"
  cluster               = aws_ecs_cluster.runtime.arn
  task_definition       = aws_ecs_task_definition.gateway.arn
  desired_count         = var.bifrost_desired_count
  wait_for_steady_state = false
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  # Never Spot: every model call goes through this service, so a reclaimed task fails the runs it
  # serves until a replacement passes health checks. The cluster still registers FARGATE_SPOT for
  # the co-located services that tolerate interruption.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.gateway.id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    container_name   = "model-gateway"
    container_port   = local.gateway_port
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  # Bifrost lists Bedrock models at startup, and the gateway reads KMS and DynamoDB, so tasks
  # wait for the task-role grants.
  depends_on = [
    aws_ecs_cluster_capacity_providers.runtime,
    aws_iam_role_policy.bedrock,
    aws_iam_role_policy.gateway,
    aws_lb_listener.http,
  ]

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "gateway_cpu" {
  alarm_name          = "model-gateway-high-cpu"
  alarm_description   = "Model gateway ECS CPU utilization is above 90 percent."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    ClusterName = aws_ecs_cluster.runtime.name
    ServiceName = aws_ecs_service.gateway.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "gateway_target_errors" {
  alarm_name          = "model-gateway-target-5xx"
  alarm_description   = "The model gateway is returning target 5xx responses."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    LoadBalancer = aws_lb.internal.arn_suffix
    TargetGroup  = aws_lb_target_group.gateway.arn_suffix
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "gateway_healthy_targets" {
  count = var.alarms_enabled && var.bifrost_desired_count > 0 ? 1 : 0

  alarm_name          = "model-gateway-no-healthy-targets"
  alarm_description   = "The model gateway has no healthy load balancer targets while the service is enabled."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    LoadBalancer = aws_lb.internal.arn_suffix
    TargetGroup  = aws_lb_target_group.gateway.arn_suffix
  }

  tags = local.common_tags
}
