import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { describeScopes } from "@deployments-ai/identity/scope-catalog";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { claimDeviceCodeFn, decideDeviceCodeFn } from "../../data/device-mutations.ts";
import {
  claimedPhase,
  codeFromFragment,
  devicePath,
  formatUserCode,
  isCompleteUserCode,
  refusedPhase,
  type DeviceCodeRefusal,
  type DevicePhase,
  type DeviceRequest,
} from "../../device/device-sign-in.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { IconTile } from "@/components/reui/icon-tile";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Code, Strong, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { SwitchAccountButton } from "../sign-out.tsx";

const START_AGAIN = (
  <>
    Run <Code>deployments auth login</Code> in your terminal again for a new code.
  </>
);

const REFUSAL_VIEWS: Readonly<
  Record<DeviceCodeRefusal, { readonly description: ReactNode; readonly title: string }>
> = {
  expired: { description: START_AGAIN, title: "This code has expired" },
  unknown: {
    description: "Check the code in your terminal and enter it again.",
    title: "We don't recognize this code",
  },
  used: {
    description: (
      <>This code was already approved, denied, or opened in another browser. {START_AGAIN}</>
    ),
    title: "This code was already used",
  },
};

function DevicePanel({
  children,
  description,
  icon,
  title,
  tone = "text-primary",
}: Readonly<{
  children?: ReactNode;
  description: ReactNode;
  icon: Parameters<typeof Icon>[0]["icon"];
  title: string;
  tone?: string;
}>) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="gap-3">
          <IconTile className={tone} size="lg" variant="soft">
            <Icon icon={icon} />
          </IconTile>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children ? <CardContent className="space-y-5">{children}</CardContent> : null}
      </Card>
    </main>
  );
}

function EnterCode({
  error,
  initialCode,
  onSubmit,
  pending,
}: Readonly<{
  error: string | undefined;
  initialCode: string;
  onSubmit: (code: string) => void;
  pending: boolean;
}>) {
  const [code, setCode] = useState(initialCode);
  const complete = isCompleteUserCode(code);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) onSubmit(code);
  };
  return (
    <DevicePanel
      description="Confirm the code to finish signing in to the Deployments.ai CLI."
      icon={ComputerTerminal01Icon}
      title="Connect the CLI"
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field invalid={error !== undefined}>
          <Label>Code</Label>
          <Input
            aria-describedby="device-code-hint"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            autoFocus
            className="h-11 text-center font-mono text-xl tracking-[0.3em] uppercase md:text-xl"
            inputMode="text"
            name="userCode"
            onChange={(event) => setCode(formatUserCode(event.currentTarget.value))}
            placeholder="ABCD-EFGH"
            spellCheck={false}
            value={code}
          />
          <Description id="device-code-hint">
            Your terminal shows this code after you run <Code>deployments auth login</Code>.
          </Description>
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </Field>
        <Button className="w-full" disabled={!complete || pending} size="lg" type="submit">
          {pending ? "Checking…" : "Continue"}
        </Button>
      </form>
    </DevicePanel>
  );
}

function ConfirmRequest({
  code,
  error,
  onDecide,
  pending,
  request,
}: Readonly<{
  code: string;
  error: string | undefined;
  onDecide: (decision: "approve" | "deny") => void;
  pending: "approve" | "deny" | undefined;
  request: DeviceRequest;
}>) {
  const groups = describeScopes(request.requestedScopes);
  const account = request.account.email ?? request.account.displayName;
  return (
    <DevicePanel
      description={
        <>
          <Strong>{request.clientName}</Strong> is asking to act as you with code{" "}
          <Code>{code}</Code>.
        </>
      }
      icon={ComputerTerminal01Icon}
      title={`Allow ${request.clientName}?`}
    >
      {account ? (
        <Text>
          Signed in as <Strong>{account}</Strong>.
        </Text>
      ) : null}
      <section aria-label="Requested access" className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">It will be able to</h2>
        <dl className="divide-y rounded-lg border">
          {groups.map((group) => (
            <div className="space-y-1 px-3 py-2.5" key={group.area}>
              <dt className="text-sm font-medium text-foreground">{group.area}</dt>
              <dd>
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {group.subjects.map((subject) => (
                    <li key={subject.subject}>
                      {subject.subject}: {subject.actions.join(", ")}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <Callout variant="warning">
        <Icon icon={Alert02Icon} />
        <CalloutTitle>Only continue if you started this sign-in</CalloutTitle>
        <CalloutDescription>
          If someone sent you this link or code, deny it. Approving gives them access to your
          account.
        </CalloutDescription>
      </Callout>
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending !== undefined} onClick={() => onDecide("approve")} size="lg">
          {pending === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button
          disabled={pending !== undefined}
          onClick={() => onDecide("deny")}
          size="lg"
          variant="outline"
        >
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
      </div>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <SwitchAccountButton returnTo={devicePath(code)} />
    </DevicePanel>
  );
}

/** One view per phase; the page owns the transitions. */
export function DevicePhaseView({
  code,
  error,
  onClaim,
  onDecide,
  onRestart,
  pending,
  phase,
}: Readonly<{
  code: string;
  error: string | undefined;
  onClaim: (code: string) => void;
  onDecide: (decision: "approve" | "deny") => void;
  onRestart: () => void;
  pending: "approve" | "claim" | "deny" | undefined;
  phase: DevicePhase;
}>) {
  switch (phase.kind) {
    case "enter":
      return (
        <EnterCode
          error={error}
          initialCode={code}
          key={code}
          onSubmit={onClaim}
          pending={pending === "claim"}
        />
      );
    case "confirm":
      return (
        <ConfirmRequest
          code={code}
          error={error}
          onDecide={onDecide}
          pending={pending === "claim" ? undefined : pending}
          request={phase.request}
        />
      );
    case "approved":
      return (
        <DevicePanel
          description={`${phase.clientName} is signed in. Return to your terminal to continue. You can close this tab.`}
          icon={CheckmarkCircle02Icon}
          title="You're signed in"
          tone="text-success"
        />
      );
    case "denied":
      return (
        <DevicePanel
          description={`${phase.clientName} was not given access. The sign-in in your terminal stops. If you did not start it, nothing else is needed.`}
          icon={CancelCircleIcon}
          title="Request denied"
          tone="text-muted-foreground"
        />
      );
    case "refused": {
      const view = REFUSAL_VIEWS[phase.reason];
      return (
        <DevicePanel
          description={view.description}
          icon={phase.reason === "expired" ? Clock01Icon : Alert02Icon}
          title={view.title}
          tone="text-destructive"
        >
          {phase.reason === "unknown" ? (
            <Button onClick={onRestart} variant="outline">
              Enter a different code
            </Button>
          ) : null}
        </DevicePanel>
      );
    }
  }
}

/**
 * The page a CLI device sign-in opens. A code in the query is claimed at once; a code in the
 * `#code=` fragment, as CLIs before this page printed, moves to the query first.
 */
export function DeviceSignIn({ code: searchCode }: Readonly<{ code: string | undefined }>) {
  const navigate = useNavigate();
  const code = formatUserCode(searchCode ?? "");
  const [phase, setPhase] = useState<DevicePhase>({ kind: "enter" });
  const [error, setError] = useState<string>();
  const failed = (cause: Error) => {
    if (cause instanceof UnauthenticatedError) return;
    const refused = refusedPhase(cause);
    if (refused) setPhase(refused);
    else setError(describeProblem(cause, "The request did not go through").title);
  };
  const claim = useMutation({
    mutationFn: (userCode: string) => claimDeviceCodeFn({ data: { userCode } }),
    onError: failed,
    onSuccess: (request) => setPhase(claimedPhase(request)),
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      decideDeviceCodeFn({ data: { decision, userCode: code } }),
    onError: failed,
    onSuccess: (_result, decision) => {
      if (phase.kind !== "confirm") return;
      const { clientName } = phase.request;
      setPhase({ clientName, kind: decision === "approve" ? "approved" : "denied" });
    },
  });
  const { mutate: claimCode } = claim;
  useEffect(() => {
    const fragment = codeFromFragment(window.location.hash);
    if (fragment && !searchCode) {
      void navigate({ replace: true, search: { code: formatUserCode(fragment) }, to: "/device" });
    }
  }, [navigate, searchCode]);
  useEffect(() => {
    if (isCompleteUserCode(code)) claimCode(code);
  }, [claimCode, code]);
  for (const cause of [claim.error, decide.error]) {
    if (cause instanceof UnauthenticatedError) throw cause;
  }
  return (
    <DevicePhaseView
      code={code}
      error={error}
      onClaim={(next) => {
        setError(undefined);
        if (next === code) claimCode(next);
        else void navigate({ search: { code: next }, to: "/device" });
      }}
      onDecide={(decision) => {
        setError(undefined);
        decide.mutate(decision);
      }}
      onRestart={() => {
        setPhase({ kind: "enter" });
        void navigate({ search: {}, to: "/device" });
      }}
      pending={claim.isPending ? "claim" : decide.isPending ? decide.variables : undefined}
      phase={phase}
    />
  );
}

/** Shown instead of the page without a session; sign-in returns here with the code. */
export function DeviceSignInRequired({ code }: Readonly<{ code: string | undefined }>) {
  const [returnTo, setReturnTo] = useState(devicePath(code));
  useEffect(() => {
    const fragment = codeFromFragment(window.location.hash);
    if (!code && fragment) setReturnTo(devicePath(formatUserCode(fragment)));
  }, [code]);
  return (
    <DevicePanel
      description="Sign in to the console with your Deployments.ai account. You come back here to confirm the code from your terminal."
      icon={ComputerTerminal01Icon}
      title="Sign in to connect the CLI"
    >
      {/* A document navigation: `/auth/login` is a server route, not a client page. */}
      <form action="/auth/login" method="get">
        <input name="returnTo" type="hidden" value={returnTo} />
        <Button className="w-full" size="lg" type="submit">
          Sign in
        </Button>
      </form>
    </DevicePanel>
  );
}
