output "private_subnet_ids" {
  value = [for zone in local.sorted_availability_zones : aws_subnet.private[zone].id]
}

output "private_route_table_ids_by_az" {
  description = "Private route table IDs keyed by Availability Zone for NAT composition."
  value       = { for zone in local.sorted_availability_zones : zone => aws_route_table.private[zone].id }
}

output "public_subnet_ids" {
  value = [for zone in local.sorted_availability_zones : aws_subnet.public[zone].id]
}

output "public_subnet_ids_by_az" {
  description = "Public subnet IDs keyed by Availability Zone for NAT composition."
  value       = { for zone in local.sorted_availability_zones : zone => aws_subnet.public[zone].id }
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "nat_gateway_ids" {
  value = values(aws_nat_gateway.this)[*].id
}
