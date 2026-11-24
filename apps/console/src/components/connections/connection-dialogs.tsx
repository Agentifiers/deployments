import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  grantImpact,
  type ConnectionView,
  type GrantView,
  type PinningDeploymentView,
  type VerificationView,
} from "../../connections/connection-state.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { revokeConnectionFn, verifyConnectionFn } from "../../data/connection-mutations.ts";
import { invalidateConnections } from "../../data/connection-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

export function VerifyConnectionDialog({
  connection,
  onClose,
  onVerified,
  open,
  scope,
}: Readonly<{
  connection: ConnectionView;
  onClose: () => void;
  onVerified: (verification: VerificationView) => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Verify"
      confirmation={typedConfirmation(environment.type, { phrase: connection.displayName })}
      description="The platform checks the credential with the provider now. This can take up to 25 seconds."
      onClose={onClose}
      onSuccess={(verification) => {
        void invalidateConnections(queryClient, scope);
        onVerified(verification);
      }}
      open={open}
      run={(idempotencyKey: string) =>
        verifyConnectionFn({ data: { connectionId: connection.id, idempotencyKey, scope } })
      }
      successMessage={(verification) =>
        verification.status === "verified" ? "Connection verified" : "Verification failed"
      }
      title={`Verify ${connection.displayName}`}
    />
  );
}

export function RevokeConnectionDialog({
  confirmLabel = "Revoke connection",
  connection,
  deployments,
  grants,
  idempotencyKey: stepKey,
  onClose,
  onRevoked,
  onSubmit,
  open,
  scope,
}: Readonly<{
  confirmLabel?: string;
  connection: ConnectionView;
  deployments: readonly PinningDeploymentView[];
  grants: readonly GrantView[];
  /** A rebind's step key, so a revoke retried from another page load replays instead. */
  idempotencyKey?: string;
  onClose: () => void;
  onRevoked?: (revoked: ConnectionView) => void;
  onSubmit: <Result>(request: Promise<Result>) => Promise<Result>;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const impact = grantImpact(connection.id, grants, deployments, "active");
  return (
    <ActionDialog
      confirmLabel={confirmLabel}
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: connection.displayName,
      })}
      description="The platform deletes the stored credential and the connection becomes disconnected. Revoking cannot be undone."
      destructive
      onClose={onClose}
      onSuccess={(revoked: ConnectionView) => {
        void invalidateConnections(queryClient, scope);
        onRevoked?.(revoked);
      }}
      open={open}
      run={(idempotencyKey) =>
        onSubmit(
          revokeConnectionFn({
            data: {
              body: { expectedVersion: connection.version },
              connectionId: connection.id,
              idempotencyKey: stepKey ?? idempotencyKey,
              scope,
            },
          }),
        )
      }
      successMessage="Connection revoked"
      title={`Revoke ${connection.displayName}?`}
    >
      {impact.grants > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>
            Also revokes {formatExact(impact.grants)} {impact.grants === 1 ? "grant" : "grants"}
          </CalloutTitle>
          <CalloutDescription>
            {formatExact(impact.deployments)}{" "}
            {impact.deployments === 1 ? "deployment loses" : "deployments lose"} the tools these
            grants authorize.
          </CalloutDescription>
        </Callout>
      ) : null}
    </ActionDialog>
  );
}
