data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_dynamodb_table" "checkpoints" {
  name         = "${local.name_prefix}-checkpoints"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "consumer"
  range_key    = "shard"

  attribute {
    name = "consumer"
    type = "S"
  }
  attribute {
    name = "shard"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  # enabled = false selects the AWS owned key; omitting the block would keep a prior key.
  server_side_encryption { enabled = false }

  deletion_protection_enabled = var.deletion_protection_enabled
  tags                        = local.common_tags
}

resource "aws_ecs_cluster" "hot" {
  name = local.name_prefix
  setting {
    name  = "containerInsights"
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }
  tags = local.common_tags
}

resource "aws_ecs_cluster_capacity_providers" "hot" {
  cluster_name       = aws_ecs_cluster.hot.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_service_discovery_service" "hot" {
  name = "hot-plane"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.private.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  tags = local.common_tags
}

resource "aws_security_group" "service" {
  name_prefix = "${local.name_prefix}-service-"
  description = "Authenticated observability hot-plane ECS service"
  vpc_id      = var.vpc_id

  ingress {
    description = "Internal authenticated observability API"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

resource "aws_iam_role" "execution" {
  name                 = "${local.name_prefix}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secret" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = concat(
      values(aws_ssm_parameter.runtime)[*].arn,
      [aws_ssm_parameter.service.arn],
    )
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "runtime-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secret.json
}

resource "aws_iam_role" "task" {
  name                 = "${local.name_prefix}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "task" {
  statement {
    actions = [
      "kinesis:DescribeStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:ListShards",
    ]
    resources = [var.fact_stream_arn]
  }
  statement {
    actions   = ["kinesis:ListStreams"]
    resources = ["*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.checkpoints.arn]
  }
  statement {
    actions   = ["dynamodb:BatchGetItem", "dynamodb:GetItem"]
    resources = [var.control_table_arn]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.quarantine_bucket_arn}/hot-writer/*"]
  }
  dynamic "statement" {
    for_each = var.ecs_exec_enabled ? [1] : []
    content {
      actions = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${local.name_prefix}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_ecs_task_definition" "hot" {
  family                   = local.name_prefix
  cpu                      = tostring(var.task_size.cpu)
  memory                   = tostring(var.task_size.memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "hot-plane"
    image     = var.hot_plane_image
    essential = true
    environment = [
      { name = "CLICKHOUSE_HOST", value = local.database_host },
      { name = "CLICKHOUSE_INGEST_USER", value = "observability_ingest" },
      { name = "CLICKHOUSE_QUERY_USER", value = "observability_query" },
      { name = "DEPLOYMENTS_AI_CONTROL_TABLE", value = var.control_table_name },
      { name = "DEPLOYMENTS_AI_ENVIRONMENT", value = var.environment },
      { name = "OBSERVABILITY_CREDENTIAL_GENERATION", value = join(",", [for parameter in values(aws_ssm_parameter.runtime) : tostring(parameter.version)]) },
      { name = "OBSERVABILITY_CHECKPOINT_TABLE", value = aws_dynamodb_table.checkpoints.name },
      { name = "OBSERVABILITY_KINESIS_STREAM_ARN", value = var.fact_stream_arn },
      { name = "OBSERVABILITY_QUARANTINE_BUCKET", value = var.quarantine_bucket_name },
      { name = "PORT", value = "3000" },
    ]
    secrets = [
      { name = "CLICKHOUSE_CA_CERTIFICATE", valueFrom = aws_ssm_parameter.runtime["ca-certificate"].arn },
      { name = "CLICKHOUSE_INGEST_PASSWORD", valueFrom = aws_ssm_parameter.runtime["ingest-password"].arn },
      { name = "CLICKHOUSE_QUERY_PASSWORD", valueFrom = aws_ssm_parameter.runtime["query-password"].arn },
      { name = "OBSERVABILITY_SERVICE_TOKEN", valueFrom = aws_ssm_parameter.service.arn },
    ]
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD-SHELL", "bun -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      retries     = 3
      startPeriod = 180
      timeout     = 10
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  lifecycle {
    precondition {
      condition     = !endswith(var.hot_plane_image, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
      error_message = "A release workflow must supply the published observability hot-plane image digest."
    }
  }
  tags = local.common_tags
}

resource "aws_ecs_service" "hot" {
  name                               = local.name_prefix
  cluster                            = aws_ecs_cluster.hot.arn
  task_definition                    = aws_ecs_task_definition.hot.arn
  desired_count                      = var.desired_count
  force_new_deployment               = true
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  enable_execute_command             = var.ecs_exec_enabled
  wait_for_steady_state              = false

  # The provider requires the forced rollout above for capacity provider strategy changes.
  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.service.id]
    subnets          = var.private_subnet_ids
  }
  service_registries { registry_arn = aws_service_discovery_service.hot.arn }

  depends_on = [aws_ecs_cluster_capacity_providers.hot, aws_service_discovery_instance.node]
  tags       = local.common_tags
}
