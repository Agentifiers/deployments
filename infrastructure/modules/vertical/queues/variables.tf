variable "name_prefix" {
  type = string
}

variable "queues" {
  type = map(object({
    visibility_timeout_seconds = optional(number, 60)
    message_retention_seconds  = optional(number, 1209600)
    max_receive_count          = optional(number, 5)
  }))
}

variable "tags" {
  type    = map(string)
  default = {}
}

