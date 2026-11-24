/** Narrow, metadata-only views of the AWS control planes the operator routes observe. */

export interface EcsServiceObservation {
  readonly desiredCount?: number;
  readonly pendingCount?: number;
  readonly rolloutState?: string;
  readonly rolloutStateReason?: string;
  readonly runningCount?: number;
  readonly serviceName: string;
  readonly status?: string;
  readonly taskDefinition?: string;
}

export interface LambdaFunctionObservation {
  /** Hex SHA-256 of the deployed code package. */
  readonly codeSha256?: string;
  readonly lastModified?: string;
}

export interface AlarmObservation {
  readonly metricName?: string;
  readonly name: string;
  readonly namespace?: string;
  readonly reason?: string;
  readonly state: "ALARM" | "INSUFFICIENT_DATA" | "OK";
  readonly updatedAt?: string;
}

export type SecretMetadataObservation =
  | {
      readonly kind: "secrets-manager";
      readonly currentVersionId?: string;
      readonly lastModifiedAt?: string;
    }
  | { readonly kind: "ssm-parameter"; readonly lastModifiedAt?: string; readonly version?: number };

export interface SystemAwsReaders {
  /** Services missing from the cluster are absent from the result. */
  readonly describeEcsServices: (
    clusterName: string,
    serviceNames: readonly string[],
  ) => Promise<ReadonlyMap<string, EcsServiceObservation>>;
  /**
   * Every function in the account and region, keyed by name, in a few paged list calls. Lambda
   * control-plane reads share one fixed per-account rate with deploys, so no reader reads
   * functions one at a time.
   */
  readonly listLambdaFunctions: () => Promise<ReadonlyMap<string, LambdaFunctionObservation>>;
  readonly describeAlarms: (input: {
    readonly maxRecords: number;
    readonly namePrefix?: string;
    readonly nextToken?: string;
    readonly state?: AlarmObservation["state"];
  }) => Promise<{ readonly alarms: readonly AlarmObservation[]; readonly nextToken?: string }>;
  /** Metadata of a secret reference; undefined when it does not exist. Never reads its value. */
  readonly describeSecret: (reference: string) => Promise<SecretMetadataObservation | undefined>;
}
