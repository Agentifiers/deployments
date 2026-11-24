output "arns" {
  value = {
    for name, parameter_name in local.parameter_names :
    name => "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${parameter_name}"
  }
}

output "names" {
  value = local.parameter_names
}
