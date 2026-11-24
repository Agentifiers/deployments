mock_provider "aws" {
  mock_data "aws_ami" {
    defaults = { id = "ami-0fedcba9876543210" }
  }

  mock_data "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000006" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_region" {
    defaults = { region = "us-east-2" }
  }

  mock_data "aws_subnet" {
    defaults = { availability_zone = "us-east-2a" }
  }

  mock_data "aws_ebs_volumes" {
    defaults = { ids = [] }
  }

  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/agent-observability-hot" }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-2:123456789012:service/srv-0123456789abcdef" }
  }
}

variables {
  alarm_topic_arn             = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  backup_retention_in_days    = 14
  container_insights_enabled  = false
  control_table_arn           = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name          = "control"
  deletion_protection_enabled = false
  detailed_monitoring_enabled = false
  ecs_exec_enabled            = false
  environment                 = "acme"
  fact_stream_arn             = "arn:aws:kinesis:us-east-2:123456789012:stream/agent-observability-facts"
  fargate_spot_enabled        = false
  hot_plane_image             = "123456789012.dkr.ecr.us-east-2.amazonaws.com/observability-hot-plane@sha256:5555555555555555555555555555555555555555555555555555555555555555"
  log_retention_in_days       = 30
  private_subnet_ids          = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  quarantine_bucket_arn       = "arn:aws:s3:::agent-observability-quarantine"
  quarantine_bucket_name      = "agent-observability-quarantine"
  vpc_cidr                    = "172.20.0.0/16"
  vpc_id                      = "vpc-0123456789abcdef0"
}

run "admits_clickhouse_clients_from_the_vpc_cidr" {
  assert {
    condition = (
      length(regexall("<networks><ip>172\\.20\\.0\\.0/16</ip></networks>", aws_instance.node.user_data)) == 2 &&
      !strcontains(aws_instance.node.user_data, "10.0.0.0/8")
    )
    error_message = "The ingest and query users must accept connections from the VPC CIDR only."
  }
}

run "installs_clickhouse_from_checksum_pinned_packages_on_the_pinned_ubuntu_image" {
  assert {
    condition     = length(terraform_data.base_ami) == 1 && aws_instance.node.ami == "ami-0fedcba9876543210"
    error_message = "Without an AMI the node must launch the Ubuntu image pinned at the first apply."
  }

  assert {
    condition = alltrue([
      for package, sha256 in local.clickhouse_packages.arm64_sha256 :
      strcontains(aws_instance.node.user_data, "${package}_${local.clickhouse_packages.version}_arm64.deb") &&
      strcontains(aws_instance.node.user_data, "echo \"${sha256}  ")
    ])
    error_message = "The bootstrap must download each pinned package and check its SHA-256."
  }
}

run "launches_an_operator_ami_without_the_ubuntu_pin" {
  variables {
    ami_id = "ami-0123456789abcdef0"
  }

  assert {
    condition     = length(terraform_data.base_ami) == 0 && aws_instance.node.ami == "ami-0123456789abcdef0"
    error_message = "An operator AMI must replace the Ubuntu pin."
  }
}

run "needs_no_operator_ami_with_deletion_protection" {
  command = plan

  variables {
    deletion_protection_enabled = true
  }

  assert {
    condition     = length(terraform_data.base_ami) == 1 && length(aws_ebs_volume.data_protected) == 1
    error_message = "A protected install must plan on the pinned Ubuntu image."
  }
}

run "alarms_on_data_volume_usage_and_stale_backups" {
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.data_volume_usage.metric_name == "DataVolumeUsedPercent" &&
      aws_cloudwatch_metric_alarm.data_volume_usage.threshold == 80 &&
      aws_cloudwatch_metric_alarm.data_volume_usage.dimensions["Environment"] == "acme" &&
      one(aws_cloudwatch_metric_alarm.data_volume_usage.alarm_actions) == var.alarm_topic_arn &&
      one(aws_cloudwatch_metric_alarm.data_volume_usage.ok_actions) == var.alarm_topic_arn
    )
    error_message = "Data-volume usage above 80 percent must notify the ops-alerts topic."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.backup.metric_name == "BackupAgeHours" &&
      aws_cloudwatch_metric_alarm.backup.threshold == 26 &&
      aws_cloudwatch_metric_alarm.backup.treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.backup.dimensions["Environment"] == "acme" &&
      one(aws_cloudwatch_metric_alarm.backup.alarm_actions) == var.alarm_topic_arn &&
      one(aws_cloudwatch_metric_alarm.backup.ok_actions) == var.alarm_topic_arn
    )
    error_message = "A missed or failed backup, or a node that stops reporting, must notify the ops-alerts topic."
  }

  assert {
    condition = (
      strcontains(aws_ssm_association.native_backup.parameters.commands, "> /var/lib/agent-observability/backup-started-at") &&
      strcontains(aws_instance.node.user_data, "MetricName=BackupAgeHours") &&
      strcontains(aws_instance.node.user_data, "MetricName=DataVolumeUsedPercent") &&
      strcontains(aws_instance.node.user_data, "systemctl enable --now agent-observability-health.timer")
    )
    error_message = "The backup must record each success, and the node must publish the metrics both alarms read."
  }
}

run "grants_the_s3_actions_a_native_backup_needs_to_finish" {
  assert {
    condition = (
      length([
        for statement in data.aws_iam_policy_document.node.statement : statement
        if contains(statement.resources, "${aws_s3_bucket.backups.arn}/*") && contains(statement.actions, "s3:DeleteObject")
      ]) == 1 &&
      !anytrue([for statement in data.aws_iam_policy_document.node.statement : contains(statement.actions, "s3:DeleteObjectVersion")])
    )
    error_message = "ClickHouse deletes the backup's .lock object when BACKUP completes, so the node needs s3:DeleteObject on the backup objects but never s3:DeleteObjectVersion."
  }
}

run "grants_the_ec2_actions_a_backup_snapshot_needs_on_the_arns_ec2_authorizes" {
  assert {
    condition = (
      alltrue([
        for action in ["ec2:CreateSnapshot", "ec2:CreateTags", "ec2:DeleteSnapshot"] : anytrue([
          for statement in data.aws_iam_policy_document.node.statement :
          contains(statement.actions, action) && contains(statement.resources, "arn:aws:ec2:us-east-2::snapshot/*")
        ])
      ]) &&
      alltrue(flatten([
        for statement in data.aws_iam_policy_document.node.statement : [
          for resource in statement.resources : resource == "arn:aws:ec2:us-east-2::snapshot/*" if strcontains(resource, ":snapshot/")
        ]
      ]))
    )
    error_message = "EC2 snapshot ARNs have no account field, so every snapshot statement must name arn:aws:ec2:us-east-2::snapshot/*."
  }

  assert {
    condition = (
      anytrue([
        for statement in data.aws_iam_policy_document.node.statement :
        contains(statement.actions, "ec2:CreateSnapshot") && anytrue([for resource in statement.resources : endswith(resource, ":volume/vol-0123456789abcdef0")])
      ]) &&
      !anytrue([
        for statement in data.aws_iam_policy_document.node.statement :
        contains(statement.actions, "ec2:CreateSnapshot") &&
        anytrue([for resource in statement.resources : strcontains(resource, ":volume/")]) &&
        anytrue([for condition in statement.condition : startswith(condition.variable, "aws:RequestTag/")])
      ])
    )
    error_message = "EC2 checks a CreateSnapshot request's tags on the new snapshot only, so the statement that admits the data volume must not require request tags."
  }
}

run "defaults_to_the_smallest_proven_node_and_task" {
  command = plan

  assert {
    condition = (
      aws_instance.node.instance_type == "t4g.medium" &&
      one(aws_instance.node.credit_specification).cpu_credits == "unlimited" &&
      one(aws_instance.node.root_block_device).volume_size == 20 &&
      aws_ebs_volume.data_unprotected[0].size == 20
    )
    error_message = "The default node must be an unlimited t4g.medium with 20 GiB root and data volumes."
  }

  assert {
    condition = (
      aws_ecs_task_definition.hot.cpu == "256" &&
      aws_ecs_task_definition.hot.memory == "512"
    )
    error_message = "The default hot-plane task must be 0.25 vCPU and 512 MiB."
  }

  assert {
    condition = (
      strcontains(aws_instance.node.user_data, "<max_server_memory_usage>0</max_server_memory_usage>") &&
      strcontains(aws_instance.node.user_data, "<max_server_memory_usage_to_ram_ratio>0.7</max_server_memory_usage_to_ram_ratio>") &&
      strcontains(aws_instance.node.user_data, "<cache_size_to_ram_max_ratio>0.1</cache_size_to_ram_max_ratio>")
    )
    error_message = "Without an explicit cap, ClickHouse must size its memory cap and caches from the instance's RAM."
  }

  assert {
    condition = (
      strcontains(aws_instance.node.user_data, "<max_threads>1</max_threads><max_execution_time>20</max_execution_time>") &&
      strcontains(aws_instance.node.user_data, "<max_memory_usage>268435456</max_memory_usage><max_concurrent_queries_for_user>8</max_concurrent_queries_for_user>") &&
      strcontains(aws_instance.node.user_data, "<log_processors_profiles>0</log_processors_profiles></observability_query>")
    )
    error_message = "The query profile must bound each query's threads, time, and memory, and the query user's concurrency, to what a t4g.medium sustains."
  }

  assert {
    condition = (
      strcontains(aws_instance.node.user_data, "<query_metric_log remove=\"1\"/>") &&
      strcontains(aws_instance.node.user_data, "<trace_log remove=\"1\"/>") &&
      strcontains(aws_instance.node.user_data, "<text_log remove=\"1\"/>") &&
      strcontains(aws_instance.node.user_data, "<asynchronous_metric_log remove=\"1\"/>") &&
      strcontains(aws_instance.node.user_data, "<size>100M</size>") &&
      strcontains(aws_instance.node.user_data, "<query_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></query_log>") &&
      strcontains(aws_instance.node.user_data, "xfs_growfs /var/lib/clickhouse")
    )
    error_message = "The node must bound its logs and grow the data filesystem after a volume resize."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.instance_cpu_surplus_credits[0].metric_name == "CPUSurplusCreditsCharged" &&
      aws_cloudwatch_metric_alarm.instance_cpu_surplus_credits[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.instance_cpu_surplus_credits[0].threshold == 0 &&
      one(aws_cloudwatch_metric_alarm.instance_cpu_surplus_credits[0].alarm_actions) == var.alarm_topic_arn
    )
    error_message = "A burstable node must alarm on charged surplus CPU credits to the ops-alerts topic."
  }
}

run "keeps_an_explicit_memory_cap" {
  command = plan

  variables {
    server_memory_bytes = 2800000000
  }

  assert {
    condition = (
      strcontains(aws_instance.node.user_data, "<max_server_memory_usage>2800000000</max_server_memory_usage>") &&
      strcontains(aws_instance.node.user_data, "<max_server_memory_usage_to_ram_ratio>0.9</max_server_memory_usage_to_ram_ratio>")
    )
    error_message = "An explicit cap must reach ClickHouse unchanged, under ClickHouse's default RAM ratio."
  }
}

run "runs_a_memory_optimized_node_without_burst_credits" {
  command = plan

  variables {
    instance_type = "r7g.large"
    task_size     = { cpu = 512, memory = 1024 }
  }

  assert {
    condition = (
      length(aws_instance.node.credit_specification) == 0 &&
      length(aws_cloudwatch_metric_alarm.instance_cpu_surplus_credits) == 0 &&
      aws_ecs_task_definition.hot.cpu == "512" &&
      aws_ecs_task_definition.hot.memory == "1024"
    )
    error_message = "An r7g node has no credit specification or surplus alarm, and the task takes the requested size."
  }
}

run "never_shrinks_an_existing_data_volume" {
  command = plan

  override_data {
    target = data.aws_ebs_volumes.existing_data
    values = { ids = ["vol-0123456789abcdef0"] }
  }

  override_data {
    target = data.aws_ebs_volume.existing_data
    values = { size = 200 }
  }

  assert {
    condition     = aws_ebs_volume.data_unprotected[0].size == 200
    error_message = "A data volume larger than data_volume_size_gib must keep its size."
  }
}

run "rejects_a_task_size_fargate_does_not_offer" {
  command = plan

  variables {
    task_size = { cpu = 256, memory = 4096 }
  }

  expect_failures = [var.task_size]
}
