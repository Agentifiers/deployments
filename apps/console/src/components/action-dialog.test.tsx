import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Field, Label, RadioField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { withClient } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";
import { ActionDialog, LockableFields, typedConfirmation } from "./action-dialog.tsx";

function Body({ locked }: { locked: boolean }) {
  return (
    <LockableFields locked={locked}>
      <Field>
        <Label>Name</Label>
        <Input />
      </Field>
      <CheckboxField>
        <Checkbox checked={false} />
        <Label>Ported scope</Label>
      </CheckboxField>
      <RadioGroup>
        <RadioField>
          <RadioGroupItem value="daily" />
          <Label>Daily</Label>
        </RadioField>
      </RadioGroup>
    </LockableFields>
  );
}

async function controlStates(locked: boolean) {
  const doc = await renderDocument(<Body locked={locked} />);
  return {
    input: doc.querySelector("input:not([type=checkbox]):not([aria-hidden])")?.matches(":disabled"),
    checkbox: doc.querySelector('[role="checkbox"]')?.getAttribute("aria-disabled"),
    radio: doc.querySelector('[role="radio"]')?.getAttribute("aria-disabled"),
  };
}

describe("LockableFields", () => {
  test("a locked body disables native, Base UI checkbox, and Base UI radio controls", async () => {
    expect(await controlStates(true)).toEqual({ input: true, checkbox: "true", radio: "true" });
  });

  test("an editable body leaves every control enabled", async () => {
    expect(await controlStates(false)).toEqual({ input: false, checkbox: null, radio: null });
  });
});

describe("typedConfirmation", () => {
  test("asks for the phrase for destructive actions anywhere and live actions only in production", () => {
    const asked = (["development", "production"] as const).flatMap((environment) =>
      [{}, { live: true }, { destructive: true }].map(
        (kind) => typedConfirmation(environment, { ...kind, phrase: "web-hook" }) ?? null,
      ),
    );
    expect(asked).toEqual([null, null, "web-hook", null, "web-hook", "web-hook"]);
  });
});

function Fields() {
  return (
    <Field>
      <Label>Name</Label>
      <Input name="name" />
    </Field>
  );
}

const openDialogs = (view: { document: Document }) =>
  view.document.querySelectorAll('[role="dialog"]').length;

describe("ActionDialog", () => {
  test("opens with focus on the first field", async () => {
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <ActionDialog
          confirmLabel="Save"
          onClose={() => {}}
          open
          run={() => Promise.resolve("saved")}
          successMessage="Saved"
          title="Save settings"
        >
          <Fields />
        </ActionDialog>
      </QueryClientProvider>,
      async (view) => {
        expect(view.document.activeElement?.getAttribute("name")).toBe("name");
      },
    );
  });

  test("Tab on the last control and Shift+Tab on the first wrap inside the dialog", async () => {
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <button type="button">Behind the dialog</button>
        <ActionDialog
          confirmLabel="Stop"
          confirmation="stop-it"
          onClose={() => {}}
          open
          run={() => Promise.resolve("stopped")}
          successMessage="Stopped"
          title="Stop deployment"
        />
      </QueryClientProvider>,
      async (view) => {
        const doc = view.document;
        const tab = (target: Element | null | undefined, shiftKey = false) => {
          const event = new (doc.defaultView as Window & typeof globalThis).KeyboardEvent(
            "keydown",
            { bubbles: true, cancelable: true, key: "Tab", shiftKey },
          );
          act(() => {
            target?.dispatchEvent(event);
          });
          return event.defaultPrevented;
        };
        const cancel = [...doc.querySelectorAll("button")].find(
          (node) => node.textContent === "Cancel",
        );
        const confirmation = doc.querySelector<HTMLInputElement>('input[name="confirmation"]');
        act(() => cancel?.focus());
        // The submit button is disabled until the phrase is typed, so Cancel is the last control.
        expect(tab(cancel)).toBe(true);
        expect(doc.activeElement === confirmation).toBe(true);
        expect(tab(confirmation, true)).toBe(true);
        expect(doc.activeElement === cancel).toBe(true);
        act(() => confirmation?.focus());
        expect(tab(confirmation)).toBe(false);
      },
    );
  });

  test("a dirty form asks before Escape or Cancel discards it", async () => {
    let closes = 0;
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <ActionDialog
          confirmLabel="Create"
          dirty
          onClose={() => closes++}
          open
          run={() => Promise.resolve("created")}
          successMessage="Created"
          title="Create agent"
        >
          <Fields />
        </ActionDialog>
      </QueryClientProvider>,
      async (view) => {
        const button = (text: string) =>
          [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);
        const steps: unknown[] = [];
        await view.press("Escape");
        steps.push(
          closes,
          openDialogs(view),
          view.document.body.textContent?.includes("Discard changes?"),
        );
        await view.click(button("Keep editing"));
        steps.push(closes, openDialogs(view));
        await view.click(button("Cancel"));
        await view.click(button("Discard changes"));
        steps.push(closes);
        expect(steps).toEqual([0, 2, true, 0, 1, 1]);
      },
    );
  });

  test("a clean form closes on Cancel without asking", async () => {
    let closes = 0;
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <ActionDialog
          confirmLabel="Create"
          onClose={() => closes++}
          open
          run={() => Promise.resolve("created")}
          successMessage="Created"
          title="Create agent"
        >
          <Fields />
        </ActionDialog>
      </QueryClientProvider>,
      async (view) => {
        await view.click(
          [...view.document.querySelectorAll("button")].find(
            (node) => node.textContent === "Cancel",
          ),
        );
        expect([closes, view.document.body.textContent?.includes("Discard changes?")]).toEqual([
          1,
          false,
        ]);
      },
    );
  });

  test("a submission that may have applied locks the body and dismissal until Leave unfinished", async () => {
    let closes = 0;
    const steps: unknown[] = [];
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <ActionDialog
          confirmLabel="Save"
          onClose={() => closes++}
          open
          run={() => Promise.reject(new Error("network down"))}
          successMessage="Saved"
          title="Save settings"
        >
          <Field>
            <Label>Name</Label>
            <Input name="name" />
          </Field>
        </ActionDialog>
      </QueryClientProvider>,
      async (view) => {
        const name = view.document.querySelector('input[name="name"]');
        const button = (text: string) =>
          [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);
        steps.push(name?.matches(":disabled"));
        await view.click(button("Save"));
        steps.push(name?.matches(":disabled"), button("Leave unfinished") !== undefined);
        await view.press("Escape");
        steps.push(closes, view.document.querySelector('[role="dialog"]') !== null);
        await view.click(button("Leave unfinished"));
        steps.push(closes);
      },
    );
    expect(steps).toEqual([false, true, true, 0, true, 1]);
  });

  test("success focus follows only a success, so a later cancel returns focus to the trigger", async () => {
    function Page() {
      const [open, setOpen] = useState(false);
      const heading = useRef<HTMLHeadingElement>(null);
      return (
        <>
          <h2 ref={heading} tabIndex={-1}>
            Settings
          </h2>
          <button onClick={() => setOpen(true)} type="button">
            Edit settings
          </button>
          <ActionDialog
            confirmLabel="Save"
            onClose={() => setOpen(false)}
            open={open}
            run={() => Promise.resolve("saved")}
            successFocus={heading}
            successMessage="Saved"
            title="Save settings"
          />
        </>
      );
    }
    const focused: (string | undefined)[] = [];
    await withClient(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
      async (view) => {
        const button = (text: string) =>
          [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);
        for (const finish of ["Save", "Cancel"]) {
          await act(async () => button("Edit settings")?.focus());
          await view.click(button("Edit settings"));
          await view.click(button(finish));
          const active = view.document.activeElement;
          focused.push(`${active?.tagName} ${active?.textContent}`);
        }
      },
    );
    expect(focused).toEqual(["H2 Settings", "BUTTON Edit settings"]);
  });
});
