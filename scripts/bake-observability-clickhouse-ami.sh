#!/usr/bin/env bash
# Bakes the agent-observability ClickHouse AMI with Packer in the current AWS account and prints
# its ID. Set the deployment's agent_observability_clickhouse_ami_id to that ID.
#
# The AMI's snapshot is encrypted with a customer managed KMS key, because release share-ami cannot
# share a snapshot under the AWS managed EBS key. CLICKHOUSE_AMI_KMS_KEY_ID names the key; without
# it the script uses the key behind alias/deployments-ai-ami, creating it on first use.
set -euo pipefail

if (($# > 0)); then
  echo "Usage: $0 (AWS_REGION selects the region; default us-east-2)" >&2
  exit 2
fi

repository_root="$(git rev-parse --show-toplevel)"
image_directory="${repository_root}/infrastructure/images/clickhouse"
source_commit="$(git -C "${repository_root}" rev-parse --short=12 HEAD)"
aws_region="${AWS_REGION:-us-east-2}"
key_alias="alias/deployments-ai-ami"

kms_key_id="${CLICKHOUSE_AMI_KMS_KEY_ID:-}"
if [[ -z "${kms_key_id}" ]]; then
  if ! kms_key_id="$(aws kms describe-key --region "${aws_region}" --key-id "${key_alias}" \
    --query KeyMetadata.Arn --output text 2>/dev/null)"; then
    kms_key_id="$(aws kms create-key --region "${aws_region}" \
      --description "Encrypts baked AMIs so they can be shared with installation accounts" \
      --query KeyMetadata.Arn --output text)"
    aws kms enable-key-rotation --region "${aws_region}" --key-id "${kms_key_id}"
    aws kms create-alias --region "${aws_region}" --alias-name "${key_alias}" --target-key-id "${kms_key_id}"
  fi
fi

packer init "${image_directory}/clickhouse.pkr.hcl"
packer build \
  -var "aws_region=${aws_region}" \
  -var "kms_key_id=${kms_key_id}" \
  -var "source_commit=${source_commit}" \
  "${image_directory}/clickhouse.pkr.hcl"

ami_id="$(jq -r '.builds[-1].artifact_id | split(":")[-1]' "${image_directory}/manifest.json")"
if [[ ! "${ami_id}" =~ ^ami-[0-9a-f]+$ ]]; then
  echo "Packer did not return an AMI ID." >&2
  exit 1
fi
aws ec2 wait image-available --region "${aws_region}" --image-ids "${ami_id}"
printf '%s\n' "${ami_id}"
