import { useRouterState, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import { REFUSED } from "../problem-copy.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Code, Text, TextLink } from "@/components/ui/text";
import { SignOutButton } from "./sign-out.tsx";

export function StatePanel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">{children}</div>
    </main>
  );
}

/** Rendered whenever the server has no usable platform session for the request. */
export function SignInRequired() {
  const returnTo = useRouterState({ select: (state) => state.location.href });
  return (
    <StatePanel>
      <Heading>Sign in required</Heading>
      <Text>Sign in with your Deployments.ai account to use the management console.</Text>
      {/* A document navigation: `/auth/login` is a server route, not a client page. */}
      <form action="/auth/login" method="get">
        <input name="returnTo" type="hidden" value={returnTo} />
        <Button type="submit">Sign in</Button>
      </form>
    </StatePanel>
  );
}

export function NotFound() {
  return (
    <StatePanel>
      <Heading>Not found</Heading>
      <Text>
        This page does not exist or you cannot access it.{" "}
        <TextLink href="/">Choose an organization</TextLink>.
      </Text>
      <SignOutButton />
    </StatePanel>
  );
}

export function ConsoleError({ error }: ErrorComponentProps) {
  if (error instanceof UnauthenticatedError) return <SignInRequired />;
  if (error instanceof PlatformApiError) {
    const { problem } = error;
    return (
      <StatePanel>
        <Heading>{problem.title}</Heading>
        {problem.detail ? <Text>{problem.detail}</Text> : null}
        {problem.status === 403 ? <Text>{REFUSED}</Text> : null}
        <Text>
          Status {problem.status}
          {problem.code ? (
            <>
              {" · "}
              <Code>{problem.code}</Code>
            </>
          ) : null}
          {problem.requestId ? (
            <>
              {" · Request "}
              <Code>{problem.requestId}</Code>
            </>
          ) : null}
        </Text>
        <SignOutButton />
      </StatePanel>
    );
  }
  return (
    <StatePanel>
      <Heading>Something went wrong</Heading>
      <Text>{error.message}</Text>
      <SignOutButton />
    </StatePanel>
  );
}
