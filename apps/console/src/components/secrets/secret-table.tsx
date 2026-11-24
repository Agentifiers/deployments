import { CREDENTIAL_REFERENCE_OWNER_TYPES } from "@deployments-ai/api-contract/credential-references";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { credentialReferencesQuery } from "../../data/secrets-queries.ts";
import {
  OWNER_LABELS,
  ownerRef,
  PURPOSE_LABELS,
  type CredentialReference,
  type OwnerType,
} from "../../secrets/secret-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

function Owner({
  reference,
  scope,
}: Readonly<{ reference: CredentialReference; scope: EnvironmentScope }>) {
  const ref = ownerRef(reference);
  const name = reference.ownerName ?? <PublicId value={reference.ownerId} />;
  return (
    <div className="flex flex-col">
      {ref === undefined ? (
        name
      ) : (
        <ResourceLink scope={scope} to={ref}>
          {name}
        </ResourceLink>
      )}
      <span className="text-xs/5 text-muted-foreground">
        {OWNER_LABELS[reference.ownerType]}, {reference.ownerStatus}
      </span>
    </div>
  );
}

function SecretRows({
  owner,
  scope,
}: Readonly<{ owner: OwnerType | undefined; scope: EnvironmentScope }>) {
  const query = credentialReferencesQuery(scope, owner);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const references = data.pages.flatMap((page) => page.items);
  if (references.length === 0 && !hasNextPage) {
    return (
      <ListEmpty
        docs="/docs/capabilities/credential-vault"
        icon={Key01Icon}
        title={
          owner === undefined
            ? "No stored secrets"
            : `No secrets held by ${OWNER_LABELS[owner].toLowerCase()}s`
        }
      >
        Connections, webhooks, MCP servers, OAuth apps, extensions, and channel bindings list their
        stored secrets here.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Owner</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Generation</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Owner updated</TableHead>
            <TableHead>Credential</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {references.map((reference) => (
            <TableRow key={`${reference.ownerType}:${reference.ownerId}`}>
              <TableCell>
                <Owner reference={reference} scope={scope} />
              </TableCell>
              <TableCell>
                {PURPOSE_LABELS[reference.purpose] ?? reference.purpose}
                {reference.providerKey ? (
                  <div className="text-xs/5 text-muted-foreground">{reference.providerKey}</div>
                ) : null}
                {reference.secretNames && reference.secretNames.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {reference.secretNames.map((name) => (
                      <Code key={name}>{name}</Code>
                    ))}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={reference.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{reference.generation}</TableCell>
              <TableCell className="whitespace-nowrap">
                {reference.expiresAt ? <Timestamp value={reference.expiresAt} /> : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={reference.updatedAt} />
              </TableCell>
              <TableCell>
                <PublicId value={reference.credentialId} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={query.queryKey}
      />
    </>
  );
}

export function SecretInventory({
  onOwner,
  owner,
  scope,
}: Readonly<{
  onOwner: (owner: OwnerType | undefined) => void;
  owner: OwnerType | undefined;
  scope: EnvironmentScope;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <FilterSelect
        label="Owner"
        onChange={(value) =>
          onOwner(CREDENTIAL_REFERENCE_OWNER_TYPES.find((type) => type === value))
        }
        options={CREDENTIAL_REFERENCE_OWNER_TYPES.map((type) => ({
          label: OWNER_LABELS[type],
          value: type,
        }))}
        value={owner}
      />
      <SectionBoundary resetKey={owner ?? "all"}>
        <SecretRows owner={owner} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
