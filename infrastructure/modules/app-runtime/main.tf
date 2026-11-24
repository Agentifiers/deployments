data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name = "apps-${var.environment}"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "apps"
    },
    var.tags,
  )
  database_users  = "arn:${data.aws_partition.current.partition}:rds-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.apps.cluster_resource_id}"
  release_objects = "${aws_s3_bucket.apps.arn}/apps/*/releases/*"
  export_objects  = "${aws_s3_bucket.apps.arn}/apps/*/exports/*"
}
