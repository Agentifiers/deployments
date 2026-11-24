import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { systemPersonByEmailQuery } from "../../data/system-queries.ts";
import type { SystemPersonMatch } from "../../server/system-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { ResendVerificationDialog } from "./person-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

type SignUp = Extract<SystemPersonMatch, { kind: "sign-up" }>["signUp"];

function PendingSignUp({ signUp }: Readonly<{ signUp: SignUp }>) {
  const [resending, setResending] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4" data-testid="person-match">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{signUp.email}</span>
        <Badge color="amber">sign-up pending</Badge>
      </div>
      <Text>
        Signed up <Timestamp value={signUp.createdAt} />, last emailed{" "}
        <Timestamp value={signUp.verificationEmailSentAt} />, expires{" "}
        <Timestamp value={signUp.expiresAt} />. The account, with principal ID{" "}
        <Code>{signUp.principalId}</Code>, exists once the email is verified.
      </Text>
      <div>
        <Button onClick={() => setResending(true)} variant="outline">
          Resend verification…
        </Button>
      </div>
      {resending ? (
        <ResendVerificationDialog
          email={signUp.email}
          onClose={() => setResending(false)}
          principalId={signUp.principalId}
        />
      ) : null}
    </div>
  );
}

function Match({ email }: Readonly<{ email: string }>) {
  const { data, error, isPending } = useQuery(systemPersonByEmailQuery(email));
  if (isPending) return <Skeleton className="h-20 rounded-lg" />;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (data === null) {
    return (
      <Text data-testid="person-match">
        Nobody has the email <Code>{email}</Code>. Search matches the whole address, not a prefix.
      </Text>
    );
  }
  if (data.kind === "sign-up") return <PendingSignUp signUp={data.signUp} />;
  const { person } = data;
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4" data-testid="person-match">
      <div className="flex flex-wrap items-center gap-2">
        <TextLink className="font-medium" href={`/system/people/${person.id}`}>
          {person.displayName ?? person.primaryEmail ?? person.id}
        </TextLink>
        <StatusBadge status={person.status} />
        {person.platformRole ? <Badge color="blue">{person.platformRole}</Badge> : null}
      </div>
      <Text>
        {person.primaryEmail} · <Code>{person.id}</Code>
      </Text>
    </div>
  );
}

/** Finds a person by their whole email, or opens a principal ID directly. */
export function PersonSearch({
  initialPrincipalId = "",
  onPrincipalId,
}: Readonly<{ initialPrincipalId?: string; onPrincipalId: (principalId: string) => void }>) {
  const [draft, setDraft] = useState("");
  const [email, setEmail] = useState<string>();
  const [principalId, setPrincipalId] = useState(initialPrincipalId);
  const id = principalId.trim();
  const validId = PUBLIC_ID_PATTERN.test(id);
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() !== "") setEmail(draft.trim());
  };
  const open = (event: FormEvent) => {
    event.preventDefault();
    if (validId) onPrincipalId(id);
  };
  return (
    <div className="flex max-w-xl flex-col gap-8">
      <form className="flex flex-col gap-4" onSubmit={search}>
        <Field>
          <Label>Email</Label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              name="email"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="person@example.com"
              type="email"
              value={draft}
            />
            <Button disabled={draft.trim() === ""} type="submit">
              Find
            </Button>
          </div>
          <Description>The whole address; case does not matter.</Description>
        </Field>
        {email === undefined ? null : <Match email={email} key={email} />}
      </form>
      <form className="flex flex-col gap-4" onSubmit={open}>
        <Field>
          <Label>Principal ID</Label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              name="principalId"
              onChange={(event) => setPrincipalId(event.target.value)}
              placeholder="01K…"
              value={principalId}
            />
            <Button disabled={!validId} type="submit" variant="outline">
              Open
            </Button>
          </div>
          <Description>
            From an organization's members on its System page, or from a security event.
          </Description>
          {id !== "" && !validId ? <ErrorMessage>Not a principal ID</ErrorMessage> : null}
        </Field>
      </form>
    </div>
  );
}
