import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import { Brain02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  BRAIN_RETRY_NOTICES,
  BRAIN_SENSITIVITIES,
  canOfferCompanyBrain,
  isBrainSlug,
  KIND_LABELS,
  slugFromName,
  type BrainKind,
  type CreateBrainBody,
  type BrainSensitivity,
} from "../../brains/model.ts";
import { createBrainFn } from "../../data/brain-mutations.ts";
import { brainListQuery, invalidateBrains } from "../../data/brain-queries.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ConsoleAuthorization } from "../../permissions.ts";
import { Description, Field, Fieldset, Label, Legend, RadioField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

export function BrainList({
  emptyAction,
  scope,
}: Readonly<{ emptyAction?: ReactNode; scope: EnvironmentScope }>) {
  const listQuery = brainListQuery(scope.organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(listQuery);
  const brains = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/brains`;
  return (
    <div className="flex flex-col gap-4">
      {brains.length === 0 ? (
        <ListEmpty
          action={emptyAction}
          docs="/docs/capabilities/brains"
          icon={Brain02Icon}
          title="No Brains you can read"
        >
          A Brain is a knowledge base that belongs to the organization. You see the Brains you own
          and the ones you hold a grant on, yourself or through your organization role.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sensitivity</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {brains.map((brain) => (
              <TableRow href={`${basePath}/${brain.id}`} key={brain.id} title={brain.name}>
                <TableCell>{brain.name}</TableCell>
                <TableCell>
                  <Code>{brain.slug}</Code>
                </TableCell>
                <TableCell>{KIND_LABELS[brain.kind]}</TableCell>
                <TableCell>
                  <StatusBadge status={brain.status} />
                </TableCell>
                <TableCell>{brain.sensitivity}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={brain.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={listQuery.queryKey}
      />
    </div>
  );
}

interface BrainDraft {
  readonly kind: BrainKind;
  readonly name: string;
  readonly sensitivity: BrainSensitivity;
  readonly slug:
    | { readonly kind: "from-name" }
    | { readonly kind: "typed"; readonly value: string };
}

const BLANK: BrainDraft = {
  kind: "member-private",
  name: "",
  sensitivity: "internal",
  slug: { kind: "from-name" },
};

export function CreateBrainDialog({
  authorization,
  onClose,
  open,
  scope,
}: Readonly<{
  authorization: ConsoleAuthorization;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(BLANK);
  const held = useKeyedSnapshot<CreateBrainBody>();
  const companyAllowed = canOfferCompanyBrain(authorization);
  const slug = draft.slug.kind === "typed" ? draft.slug.value : slugFromName(draft.name);
  const kinds: readonly BrainKind[] = companyAllowed
    ? ["company", "member-private"]
    : ["member-private"];
  const body: CreateBrainBody = {
    kind: draft.kind,
    name: draft.name.trim(),
    sensitivity: draft.sensitivity,
    slug,
  };
  return (
    <ActionDialog
      confirmLabel="Create Brain"
      description="The Brain belongs to the organization, and you receive its owner grant."
      invalid={draft.name.trim() === "" || !isBrainSlug(slug)}
      onClose={() => {
        setDraft(BLANK);
        void invalidateBrains(queryClient, scope.organizationId);
        onClose();
      }}
      onSuccess={(brain: BrainResponse) =>
        void navigate({ to: `${environmentPath(scope)}/brains/${brain.id}` })
      }
      open={open}
      retryNotice={BRAIN_RETRY_NOTICES.create}
      run={(idempotencyKey, resend) =>
        createBrainFn({
          data: {
            body: held(idempotencyKey, resend, body),
            idempotencyKey,
            scope: { organizationId: scope.organizationId },
          },
        })
      }
      successMessage={(brain: BrainResponse) => `Created ${brain.name}`}
      title="Create Brain"
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field invalid={slug !== "" && !isBrainSlug(slug)}>
        <Label>Slug</Label>
        <Description>
          Up to 80 lowercase letters, digits, and hyphens. Unique in the organization.
        </Description>
        <Input
          autoComplete="off"
          onChange={(event) =>
            setDraft({ ...draft, slug: { kind: "typed", value: event.target.value } })
          }
          value={slug}
        />
      </Field>
      <Fieldset>
        <Legend>Kind</Legend>
        <RadioGroup
          onValueChange={(value: string) => {
            const kind = oneOf(kinds, value);
            if (kind) setDraft({ ...draft, kind });
          }}
          value={draft.kind}
        >
          {kinds.map((kind) => (
            <RadioField key={kind}>
              <RadioGroupItem value={kind} />
              <Label>{KIND_LABELS[kind]}</Label>
              <Description>
                {kind === "company"
                  ? "Shared through grants to people, organization roles, and agents."
                  : "Yours alone. Only agents and service accounts can be granted access."}
              </Description>
            </RadioField>
          ))}
        </RadioGroup>
        {companyAllowed ? null : (
          <Text>Only organization owners and admins can create company Brains.</Text>
        )}
      </Fieldset>
      <Field>
        <Label>Sensitivity</Label>
        <Description>
          A label on the Brain&apos;s documents. Search does not filter on it.
        </Description>
        <NativeSelect
          onChange={(event) => {
            const sensitivity = oneOf(BRAIN_SENSITIVITIES, event.target.value);
            if (sensitivity) setDraft({ ...draft, sensitivity });
          }}
          value={draft.sensitivity}
        >
          {BRAIN_SENSITIVITIES.map((sensitivity) => (
            <option key={sensitivity} value={sensitivity}>
              {sensitivity}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}
