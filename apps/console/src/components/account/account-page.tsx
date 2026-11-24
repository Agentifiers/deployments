import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AccountSecurity } from "../../account/account-security.ts";
import { accountSecurityQuery, accountSessionsQuery } from "../../data/account-queries.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AccountDialogs, AccountSignOutForm, type AccountDialog } from "./account-dialogs.tsx";
import { AccountDeletion, AccountEmail } from "./account-lifecycle.tsx";

type OpenDialog = (dialog: AccountDialog) => void;

function PasswordCard({ open }: Readonly<{ open: OpenDialog }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing it signs you out of every browser, console, and CLI session.
        </CardDescription>
        <CardAction>
          <Button onClick={() => open({ kind: "change-password" })} variant="outline">
            Change password
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

function MfaCard({ mfa, open }: Readonly<{ mfa: AccountSecurity["mfa"]; open: OpenDialog }>) {
  if (mfa.state === "off") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            Two-factor authentication <Badge>off</Badge>
          </CardTitle>
          <CardDescription>
            Ask for a code from an authenticator app after your password when you sign in.
          </CardDescription>
          <CardAction>
            <Button onClick={() => open({ kind: "enroll-mfa" })}>Turn on</Button>
          </CardAction>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Two-factor authentication <Badge color="green">on</Badge>
        </CardTitle>
        <CardDescription>
          On since <Timestamp value={mfa.activatedAt} />. Signing in asks for a code from your
          authenticator app or a recovery code.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <Button onClick={() => open({ kind: "regenerate-codes" })} variant="outline">
            Replace recovery codes
          </Button>
          <Button onClick={() => open({ kind: "disable-mfa" })} variant="outline">
            Turn off
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Text>
          {mfa.recoveryCodesRemaining === 1
            ? "1 unused recovery code left."
            : `${mfa.recoveryCodesRemaining} unused recovery codes left.`}
          {mfa.recoveryCodesRemaining <= 3 ? " Replace them before you run out." : null}
        </Text>
      </CardContent>
    </Card>
  );
}

function SecurityCards({ open }: Readonly<{ open: OpenDialog }>) {
  const { data } = useSuspenseQuery(accountSecurityQuery());
  return (
    <>
      {data.passwordSignIn ? <PasswordCard open={open} /> : null}
      {data.passwordSignIn ? (
        <MfaCard mfa={data.mfa} open={open} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sign-in</CardTitle>
            <CardDescription>
              You sign in through your organization's identity provider, which manages your password
              and two-factor authentication.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </>
  );
}

function SessionsCard({ open }: Readonly<{ open: OpenDialog }>) {
  const query = accountSessionsQuery();
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const sessions = data.pages.flatMap((page) => page.items);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser sessions</CardTitle>
        <CardDescription>
          Each browser signed in to your account. Signing one out also ends the console and CLI
          sessions started from it.
        </CardDescription>
        <CardAction>
          <Button onClick={() => open({ kind: "sign-out-everywhere" })} variant="destructive">
            Sign out everywhere
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessions.length === 0 ? (
          <Text>No active browser sessions.</Text>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Browser</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      {session.deviceLabel ?? "Unknown browser"}
                      {session.current ? <Badge color="blue">this browser</Badge> : null}
                    </span>
                    <span className="block text-muted-foreground">
                      Signed in <Timestamp value={session.authenticationTime} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <Timestamp value={session.lastRefreshedAt} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={session.expiresAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      aria-label={
                        session.current
                          ? "Sign out this browser"
                          : `Sign out the session from ${session.authenticationTime}`
                      }
                      onClick={() => open({ kind: "revoke-session", sessionId: session.id })}
                      variant="outline"
                    >
                      Sign out
                    </Button>
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
          queryKey={query.queryKey}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The signed-in person's own account, outside any organization. Its route loader should ensure
 * `accountSecurityQuery()` and prefetch `accountProfileQuery()` and `accountSessionsQuery()`.
 */
export function AccountPage() {
  const [dialog, setDialog] = useState<AccountDialog>();
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 lg:py-16">
      <div className="space-y-2">
        <Button href="/" variant="ghost">
          <Icon icon={ArrowLeft01Icon} />
          Organizations
        </Button>
        <Heading>Account security</Heading>
      </div>
      <SectionBoundary resetKey="email">
        <AccountEmail />
      </SectionBoundary>
      <SectionBoundary resetKey="security">
        <SecurityCards open={setDialog} />
      </SectionBoundary>
      <SectionBoundary resetKey="sessions">
        <SessionsCard open={setDialog} />
      </SectionBoundary>
      <SectionBoundary resetKey="deletion">
        <AccountDeletion />
      </SectionBoundary>
      <AccountSignOutForm />
      <AccountDialogs dialog={dialog} onClose={() => setDialog(undefined)} />
    </main>
  );
}
