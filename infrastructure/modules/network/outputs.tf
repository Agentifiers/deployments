output "private_subnet_ids" {
  value = [for zone in local.sorted_availability_zones : aws_subnet.private[zone].id]
}

output "public_subnet_ids" {
  value = [for zone in local.sorted_availability_zones : aws_subnet.public[zone].id]
}

output "s3_prefix_list_id" {
  description = "Prefix list of the S3 gateway endpoint that every private subnet's route table reaches S3 through."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "nat_mode" {
  description = "Configured private-subnet IPv4 egress implementation."
  value       = var.nat_mode
}

output "nat_public_ip" {
  description = "Public IPv4 address used by the single development NAT instance, when configured."
  value       = try(aws_eip.nat_instance[0].public_ip, null)
}

output "reserved_ipv4_egress_filtered" {
  description = "Whether private-subnet forwarding rejects the platform's canonical private and reserved IPv4 ranges."
  value       = var.nat_mode == "instance"
}
