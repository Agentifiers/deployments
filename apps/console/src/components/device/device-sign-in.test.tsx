import { describe, expect, test } from "bun:test";
import { renderDocument } from "@/components/ui/render-document";
import type { DevicePhase, DeviceRequest } from "../../device/device-sign-in.ts";
import { DevicePhaseView, DeviceSignInRequired } from "./device-sign-in.tsx";

const request: DeviceRequest = {
  account: { displayName: "Ada Lovelace", email: "ada@example.com" },
  approved: false,
  clientId: "deployments-cli",
  clientName: "Deployments CLI",
  requestedScopes: ["offline_access", "agents:read", "agents:write", "runs:read"],
};

const noop = () => {};

function render(phase: DevicePhase, extra: { code?: string; error?: string } = {}) {
  return renderDocument(
    <DevicePhaseView
      code={extra.code ?? "ABCD-EFGH"}
      error={extra.error}
      onClaim={noop}
      onDecide={noop}
      onRestart={noop}
      pending={undefined}
      phase={phase}
    />,
  );
}

const text = (document: Document) => document.body.textContent?.replaceAll(/\s+/gu, " ") ?? "";
const buttons = (document: Document) =>
  [...document.querySelectorAll("button")].map((button) => button.textContent);

describe("device sign-in page", () => {
  test("enter: prefills the code and says it comes from the terminal", async () => {
    const document = await render({ kind: "enter" });
    const input = document.querySelector<HTMLInputElement>('input[name="userCode"]');

    expect(document.querySelector("[data-slot=card-title]")?.textContent).toBe("Connect the CLI");
    expect(input?.value).toBe("ABCD-EFGH");
    expect(text(document)).toContain(
      "Your terminal shows this code after you run deployments auth login.",
    );
    expect(buttons(document)).toEqual(["Continue"]);
  });

  test("enter: an empty code cannot be submitted and an error shows under the field", async () => {
    const document = await render({ kind: "enter" }, { code: "", error: "Service unavailable" });

    expect(document.querySelector<HTMLInputElement>('input[name="userCode"]')?.value).toBe("");
    expect(document.querySelector("button")?.hasAttribute("disabled")).toBeTrue();
    expect(document.querySelector("[data-slot=field-error]")?.textContent).toBe(
      "Service unavailable",
    );
  });

  test("confirm: names the client and account, groups access in plain words, and warns", async () => {
    const document = await render({ kind: "confirm", request });
    const areas = [...document.querySelectorAll('[aria-label="Requested access"] dt')].map(
      (term) => term.textContent,
    );
    const grants = [...document.querySelectorAll('[aria-label="Requested access"] li')].map(
      (item) => item.textContent,
    );

    expect(document.querySelector("[data-slot=card-title]")?.textContent).toBe(
      "Allow Deployments CLI?",
    );
    expect(text(document)).toContain("Signed in as ada@example.com.");
    expect(areas).toEqual(["Your account", "Agents and automation"]);
    expect(grants).toEqual([
      "Your sign-in: keep active until you sign out",
      "Agents: view, create and change",
      "Runs and threads: view",
    ]);
    expect(text(document)).not.toContain("agents:read");
    expect(text(document)).toContain("Only continue if you started this sign-in");
    expect(buttons(document)).toEqual(["Approve", "Deny", "Sign in with a different account"]);
  });

  test("approved: sends the person back to the terminal", async () => {
    const document = await render({ clientName: "Deployments CLI", kind: "approved" });

    expect(document.querySelector("[data-slot=card-title]")?.textContent).toBe("You're signed in");
    expect(text(document)).toContain("Return to your terminal to continue.");
    expect(buttons(document)).toEqual([]);
  });

  test("denied: says the terminal sign-in stops", async () => {
    const document = await render({ clientName: "Deployments CLI", kind: "denied" });

    expect(document.querySelector("[data-slot=card-title]")?.textContent).toBe("Request denied");
    expect(text(document)).toContain("The sign-in in your terminal stops.");
  });

  test("refused: expired, used, and unknown codes each get their own advice", async () => {
    const titles: (string | null | undefined)[] = [];
    const actions: string[][] = [];
    for (const reason of ["expired", "used", "unknown"] as const) {
      const document = await render({ kind: "refused", reason });
      titles.push(document.querySelector("[data-slot=card-title]")?.textContent);
      actions.push(buttons(document).filter((label) => label !== null));
    }

    expect(titles).toEqual([
      "This code has expired",
      "This code was already used",
      "We don't recognize this code",
    ]);
    expect(actions).toEqual([[], [], ["Enter a different code"]]);
  });

  test("signed out: sign-in returns to the device page with the code", async () => {
    const document = await renderDocument(<DeviceSignInRequired code="ABCD-EFGH" />);

    expect(document.querySelector("form")?.getAttribute("action")).toBe("/auth/login");
    expect(document.querySelector<HTMLInputElement>('input[name="returnTo"]')?.value).toBe(
      "/device?code=ABCD-EFGH",
    );
  });
});
