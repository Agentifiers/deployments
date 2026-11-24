import type { AppChoice } from "../../connections/oauth.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { TextLink } from "@/components/ui/text";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";

/**
 * The OAuth app an authorization uses: a picker when the provider has several active apps, and
 * the reason the authorization cannot start when its apps did not load or it needs one.
 */
export function OAuthAppPicker({
  choice,
  error,
  onPick,
  providerName,
  scope,
}: Readonly<{
  choice: AppChoice | undefined;
  error: Error | null;
  onPick: (appId: string) => void;
  providerName: string;
  scope: EnvironmentScope;
}>) {
  if (error instanceof UnauthenticatedError) throw error;
  if (error) {
    const problem = describeProblem(error, "OAuth apps did not load");
    return (
      <Callout variant="destructive">
        <CalloutTitle>{problem.title}</CalloutTitle>
        <CalloutDescription>
          {problem.description ? <p>{problem.description}</p> : null}
          <ProblemReference requestId={problem.requestId} status={problem.status} />
        </CalloutDescription>
      </Callout>
    );
  }
  if (choice?.kind === "missing") {
    return (
      <Callout variant="destructive">
        <CalloutTitle>Register an OAuth app first</CalloutTitle>
        <CalloutDescription>
          {providerName} accepts only clients registered with it. Register one on the{" "}
          <TextLink href={`${environmentPath(scope)}/connections/oauth-apps`}>OAuth apps</TextLink>{" "}
          tab.
        </CalloutDescription>
      </Callout>
    );
  }
  if ((choice?.kind !== "chosen" && choice?.kind !== "choose") || choice.active.length < 2) {
    return null;
  }
  return (
    <Field>
      <Label>OAuth app</Label>
      <NativeSelect
        onChange={(event) => onPick(event.target.value)}
        value={choice.kind === "chosen" ? choice.app.id : ""}
      >
        <option value="">Choose an app</option>
        {choice.active.map((app) => (
          <option key={app.id} value={app.id}>
            {app.displayName} ({app.clientId})
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
