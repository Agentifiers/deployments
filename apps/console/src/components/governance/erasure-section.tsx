import { Delete02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { requestErasureFn } from "../../data/governance-mutations.ts";
import { organizationErasureQuery } from "../../data/governance-queries.ts";
import { ERASE_PHRASE } from "../../governance/erasure-state.ts";
import type { OperationView } from "../../governance/operation-state.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

const ERASURE_KEEPS = [
  "Copies held by model, channel, and tool providers, which follow each provider's own retention.",
  "Audit exports, which stay locked until their retention date.",
  "An erasure receipt with hashes and counts, which proves the erasure happened.",
];

export function ErasureSection({ organizationId }: Readonly<{ organizationId: string }>) {
  const { data: erasure } = useSuspenseQuery(organizationErasureQuery(organizationId));
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Erase organization</Subheading>
      <Callout variant="destructive">
        <CalloutTitle>Erasure deletes this organization and cannot be undone</CalloutTitle>
        <CalloutDescription>
          <p>
            Every project, environment, agent, run, thread, file, and member is deleted, along with
            search indexes and observability data. Every member loses access, and API keys stop
            working. Runs must be stopped first. These remain:
          </p>
          <ul className="list-disc pl-5">
            {ERASURE_KEEPS.map((kept) => (
              <li key={kept}>{kept}</li>
            ))}
          </ul>
        </CalloutDescription>
      </Callout>
      {erasure.kind === "not_requested" ? (
        <div>
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            <Icon icon={Delete02Icon} />
            Erase organization
          </Button>
        </div>
      ) : (
        <Text>
          An erasure was requested.{" "}
          <Link
            className="font-medium underline"
            params={{ operationId: erasure.operationId, orgId: organizationId }}
            to="/erasures/$orgId/$operationId"
          >
            Follow its progress
          </Link>
          .
        </Text>
      )}
      <ActionDialog
        confirmLabel="Erase organization"
        confirmation={ERASE_PHRASE}
        description="This permanently deletes the organization and everything in it. Only the person who requests the erasure can resume it if it stops."
        destructive
        onClose={() => setConfirming(false)}
        onSuccess={(operation: OperationView) =>
          void navigate({
            params: { operationId: operation.id, orgId: organizationId },
            to: "/erasures/$orgId/$operationId",
          })
        }
        open={confirming}
        retryNotice="Try again to finish the request; it resumes the same erasure."
        run={(idempotencyKey) =>
          requestErasureFn({ data: { idempotencyKey, scope: { organizationId } } })
        }
        successMessage="Erasure requested"
        title="Erase this organization?"
      />
    </section>
  );
}
