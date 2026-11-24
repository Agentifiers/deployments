output "auth_key_parameter_name" {
  description = "SSM SecureString parameter the relay polls for its Tailscale auth key."
  value       = aws_ssm_parameter.auth_key.name
}

output "instance_id" {
  description = "Relay EC2 instance ID."
  value       = aws_instance.relay.id
}

output "private_ip" {
  description = "VPC address that accepts connections on the upstream port."
  value       = aws_instance.relay.private_ip
}

output "tailnet_hostname" {
  description = "Hostname the relay registers in the tailnet."
  value       = var.tailnet_hostname
}
