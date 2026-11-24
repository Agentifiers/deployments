export const SYSTEM_ACCOUNT_ID_ENV = "DEPLOYMENTS_AI_AWS_ACCOUNT_ID";

export interface IamRole {
  readonly account: string;
  readonly name: string;
  readonly partition: string;
}

const ROLE_ARN = /^arn:([^:]+):iam::(\d{12}):role\/(?:[^/]+\/)*([^/]+)$/u;
const ASSUMED_ROLE_ARN = /^arn:([^:]+):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/u;

export function parseRoleArn(arn: string): IamRole | undefined {
  const [, partition, account, name] = ROLE_ARN.exec(arn) ?? [];
  return partition && account && name ? { account, name, partition } : undefined;
}

/**
 * An assumed-role ARN drops the role's path, and role names are unique within an account whatever
 * their path, so the partition, account, and name identify the role.
 */
export function sessionRole(iamUserArn: string | undefined): IamRole | undefined {
  const [, partition, account, name] = ASSUMED_ROLE_ARN.exec(iamUserArn ?? "") ?? [];
  return partition && account && name ? { account, name, partition } : undefined;
}

export function isSameRole(left: IamRole, right: IamRole) {
  return (
    left.partition === right.partition && left.account === right.account && left.name === right.name
  );
}
