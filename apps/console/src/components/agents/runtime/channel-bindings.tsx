import { MessageMultiple01Icon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentChannelsQuery, channelDeliveryQuery } from "../../../data/agent-runtime-queries.ts";
import { channelIngressUrl } from "../../../integrations/endpoints.ts";
import { formatExact } from "../../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import type { AgentDetail } from "../../../server/agent-data.ts";
import type {
  AgentChannels,
  ChannelBinding,
  ChannelDelivery,
} from "../../../server/agent-runtime-data.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CodeBlock, CodeBlockCopyButton } from "@/components/reui/code-block/code-block";
import { Text, TextLink } from "@/components/ui/text";
import { DocsLink } from "../../docs-link.tsx";
import { ListEmpty } from "../../list-controls.tsx";
import { Timestamp } from "../../observability/panels.tsx";
import { PublicId } from "../../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

/** What the binding's last provider check found; the API verifies only on request. */
function verification(binding: ChannelBinding) {
  if (binding.lastVerifiedAt) return <Timestamp value={binding.lastVerifiedAt} />;
  return binding.credentialAttached ? "Not verified" : "No credential";
}

function lastDelivery(deliveries: readonly ChannelDelivery[], bindingId: string) {
  return deliveries.find((delivery) => delivery.bindingId === bindingId);
}

/**
 * Bindings that name the agent or route to one of its deployments, and the deliveries sent
 * through them. Read only: bindings are created, given credentials, and verified through the API.
 */
export function ChannelBindings({
  agent,
  scope,
}: Readonly<{ agent: AgentDetail; scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(
    agentChannelsQuery(
      scope,
      agent.definition.id,
      agent.deployments.map((deployment) => deployment.id),
    ),
  );
  const [openBinding, setOpenBinding] = useState<string>();
  const [openDelivery, setOpenDelivery] = useState<ChannelDelivery>();
  const binding = data.bindings.find((entry) => entry.id === openBinding);

  if (data.bindings.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/channels"
        icon={MessageMultiple01Icon}
        title="No channel bindings"
      >
        A binding connects one of this agent&apos;s deployments to a messaging channel. Bindings are
        created and verified through the API.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <Text>
        Bindings are created, given credentials, and verified through the API.{" "}
        <DocsLink path="/docs/api/reference/runtime/create-channel-binding/">
          Channel binding API reference
        </DocsLink>
      </Text>
      <BindingTable data={data} onOpen={setOpenBinding} />
      <section className="flex flex-col gap-3">
        <Subheading level={3}>Recent deliveries</Subheading>
        {data.deliveriesComplete ? null : (
          <Text>
            The environment has more deliveries than the console reads, so older ones are not
            listed.
          </Text>
        )}
        <DeliveryTable deliveries={data.deliveries} onOpen={setOpenDelivery} scope={scope} />
      </section>
      <Sheet
        onOpenChange={(open) => (open ? undefined : setOpenBinding(undefined))}
        open={binding !== undefined}
      >
        <SheetContent className="sm:max-w-xl">
          {binding ? (
            <BindingDetail
              binding={binding}
              deliveries={data.deliveries.filter((entry) => entry.bindingId === binding.id)}
              ingressOrigin={data.ingressOrigin}
              onOpenDelivery={setOpenDelivery}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <Sheet
        onOpenChange={(open) => (open ? undefined : setOpenDelivery(undefined))}
        open={openDelivery !== undefined}
      >
        <SheetContent className="sm:max-w-xl">
          {openDelivery ? <DeliveryDetail delivery={openDelivery} scope={scope} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function BindingTable({
  data,
  onOpen,
}: Readonly<{ data: AgentChannels; onOpen: (bindingId: string) => void }>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Binding</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Deployment</TableHead>
          <TableHead>Verified</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last delivery</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.bindings.map((binding) => {
          const last = lastDelivery(data.deliveries, binding.id);
          return (
            <TableRow key={binding.id}>
              <TableCell>
                <button
                  className="font-medium text-foreground underline decoration-foreground/50 underline-offset-2 hover:decoration-foreground"
                  onClick={() => onOpen(binding.id)}
                  type="button"
                >
                  {binding.channel}
                </button>{" "}
                <PublicId value={binding.id} />
              </TableCell>
              <TableCell>{binding.provider}</TableCell>
              <TableCell>
                <StatusBadge status={binding.status} />
              </TableCell>
              <TableCell>
                {binding.agentDeploymentId ? (
                  <PublicId value={binding.agentDeploymentId} />
                ) : (
                  "Agent default"
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{verification(binding)}</TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={binding.createdAt} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {last ? (
                  <span className="flex items-center gap-2">
                    <StatusBadge status={last.status} />
                    <Timestamp value={last.createdAt} />
                  </span>
                ) : (
                  "None read"
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function BindingDetail({
  binding,
  deliveries,
  ingressOrigin,
  onOpenDelivery,
}: Readonly<{
  binding: ChannelBinding;
  deliveries: readonly ChannelDelivery[];
  ingressOrigin: string | undefined;
  onOpenDelivery: (delivery: ChannelDelivery) => void;
}>) {
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {binding.channel} binding
          <StatusBadge status={binding.status} />
        </SheetTitle>
        <SheetDescription>
          Read only. Change a binding, its credential, or its verification through the API.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        <DescriptionList>
          <DescriptionTerm>Binding</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={binding.id} />
          </DescriptionDetails>
          <DescriptionTerm>Provider</DescriptionTerm>
          <DescriptionDetails>{binding.provider}</DescriptionDetails>
          <DescriptionTerm>Deployment</DescriptionTerm>
          <DescriptionDetails>
            {binding.agentDeploymentId ? (
              <PublicId value={binding.agentDeploymentId} />
            ) : (
              "Agent default"
            )}
          </DescriptionDetails>
          <DescriptionTerm>External workspace</DescriptionTerm>
          <DescriptionDetails>{binding.externalWorkspaceId ?? "—"}</DescriptionDetails>
          <DescriptionTerm>External channel</DescriptionTerm>
          <DescriptionDetails>{binding.externalChannelId ?? "—"}</DescriptionDetails>
          <DescriptionTerm>Credential</DescriptionTerm>
          <DescriptionDetails>
            {binding.credentialAttached ? "Attached" : "None"}
          </DescriptionDetails>
          <DescriptionTerm>Last verified</DescriptionTerm>
          <DescriptionDetails>{verification(binding)}</DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={binding.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Updated</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={binding.updatedAt} />
          </DescriptionDetails>
        </DescriptionList>
        {ingressOrigin ? (
          <section className="flex flex-col gap-2">
            <Subheading level={3}>Ingress URL</Subheading>
            <Text>
              The provider posts this binding&apos;s inbound messages here. Register it with the
              provider once the binding is active.
            </Text>
            <CodeBlock
              code={channelIngressUrl(ingressOrigin, binding)}
              defaultWrap
              label="Ingress URL"
            >
              <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Ingress URL" }} />
            </CodeBlock>
          </section>
        ) : null}
        <section className="flex flex-col gap-2">
          <Subheading level={3}>Recent deliveries</Subheading>
          {deliveries.length === 0 ? (
            <Text>No delivery through this binding was read.</Text>
          ) : (
            <ul className="flex flex-col gap-1">
              {deliveries.slice(0, 10).map((delivery) => (
                <li className="flex items-center gap-2 text-sm/6" key={delivery.id}>
                  <StatusBadge status={delivery.status} />
                  <button
                    className="underline decoration-foreground/50 underline-offset-2"
                    onClick={() => onOpenDelivery(delivery)}
                    type="button"
                  >
                    <Timestamp value={delivery.createdAt} />
                  </button>
                  <span className="truncate text-muted-foreground">{delivery.contentPreview}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </SheetBody>
    </>
  );
}

function DeliveryTable({
  deliveries,
  onOpen,
  scope,
}: Readonly<{
  deliveries: readonly ChannelDelivery[];
  onOpen: (delivery: ChannelDelivery) => void;
  scope: EnvironmentScope;
}>) {
  if (deliveries.length === 0) {
    return <Text>No delivery has gone out through these bindings.</Text>;
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Binding</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Run</TableHead>
          <TableHead>Content</TableHead>
          <TableHead>Last error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deliveries.map((delivery) => (
          <TableRow key={delivery.id}>
            <TableCell className="whitespace-nowrap">
              <button
                className="underline decoration-foreground/50 underline-offset-2"
                onClick={() => onOpen(delivery)}
                type="button"
              >
                <Timestamp value={delivery.createdAt} />
              </button>
            </TableCell>
            <TableCell>
              <StatusBadge status={delivery.status} />
            </TableCell>
            <TableCell>
              {delivery.bindingId ? <PublicId value={delivery.bindingId} /> : "—"}
            </TableCell>
            <TableCell className="tabular-nums">{formatExact(delivery.attempts)}</TableCell>
            <TableCell>
              <TextLink href={`${environmentPath(scope)}/runs/${delivery.runId}`}>
                <PublicId value={delivery.runId} />
              </TextLink>
            </TableCell>
            <TableCell className="max-w-56 truncate">{delivery.contentPreview}</TableCell>
            <TableCell className="max-w-56 truncate">{delivery.lastError ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The delivery as listed, refreshed from `getChannelDelivery` while the drawer is open. */
function DeliveryDetail({
  delivery: listed,
  scope,
}: Readonly<{ delivery: ChannelDelivery; scope: EnvironmentScope }>) {
  const current = useQuery(channelDeliveryQuery(scope, listed.runId, listed.id));
  const delivery = current.data ?? listed;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          Delivery <StatusBadge status={delivery.status} />
        </SheetTitle>
        <SheetDescription>
          A message the agent sent to {delivery.channel} through {delivery.provider}.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        {current.error ? (
          <Text>The latest state could not be read: {current.error.message}</Text>
        ) : null}
        <DescriptionList>
          <DescriptionTerm>Delivery</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={delivery.id} />
          </DescriptionDetails>
          <DescriptionTerm>Attempts</DescriptionTerm>
          <DescriptionDetails className="tabular-nums">
            {formatExact(delivery.attempts)}
          </DescriptionDetails>
          <DescriptionTerm>Last error</DescriptionTerm>
          <DescriptionDetails>{delivery.lastError ?? "None"}</DescriptionDetails>
          <DescriptionTerm>Provider message</DescriptionTerm>
          <DescriptionDetails>{delivery.providerMessageId ?? "—"}</DescriptionDetails>
          <DescriptionTerm>External thread</DescriptionTerm>
          <DescriptionDetails className="break-all">
            {delivery.externalThreadKey}
          </DescriptionDetails>
          <DescriptionTerm>Run</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${environmentPath(scope)}/runs/${delivery.runId}`}>
              <PublicId value={delivery.runId} />
            </TextLink>
          </DescriptionDetails>
          <DescriptionTerm>Thread</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${environmentPath(scope)}/threads/${delivery.threadId}`}>
              <PublicId value={delivery.threadId} />
            </TextLink>
          </DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={delivery.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Sent</DescriptionTerm>
          <DescriptionDetails>
            {delivery.sentAt ? <Timestamp value={delivery.sentAt} /> : "—"}
          </DescriptionDetails>
          <DescriptionTerm>Failed</DescriptionTerm>
          <DescriptionDetails>
            {delivery.failedAt ? <Timestamp value={delivery.failedAt} /> : "—"}
          </DescriptionDetails>
        </DescriptionList>
        <section className="flex flex-col gap-2">
          <Subheading level={3}>Content</Subheading>
          <Text className="whitespace-pre-wrap">{delivery.contentPreview}</Text>
        </section>
      </SheetBody>
    </>
  );
}
