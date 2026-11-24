import { LogoutSquare01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Icon } from "./icon.tsx";

/** Lets a dropdown item outside the form submit it through `form={SIGN_OUT_FORM_ID}`. */
export const SIGN_OUT_FORM_ID = "console-sign-out";

/** `/auth/logout` is a server route; signing out is a same-origin form post. */
export function SignOutForm() {
  return <form action="/auth/logout" hidden id={SIGN_OUT_FORM_ID} method="post" />;
}

export function SignOutButton() {
  return (
    <form action="/auth/logout" method="post">
      <Button type="submit" variant="outline">
        <Icon icon={LogoutSquare01Icon} />
        Sign out
      </Button>
    </form>
  );
}

/**
 * Signs out, then forces the identity provider's sign-in form (`prompt=login`) so another account
 * can sign in; a plain sign-in would silently reuse the provider's live session.
 */
export function SwitchAccountButton({ returnTo }: Readonly<{ returnTo: string }>) {
  return (
    <form action="/auth/logout" method="post">
      <input name="prompt" type="hidden" value="login" />
      <input name="returnTo" type="hidden" value={returnTo} />
      <Button type="submit" variant="outline">
        Sign in with a different account
      </Button>
    </form>
  );
}
