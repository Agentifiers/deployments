import { describe, expect, test } from "bun:test";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  FieldGroup,
  Fieldset,
  Label,
  Legend,
  RadioField,
  SwitchField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { withClient } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

function DialogBody({ locked }: { locked: boolean }) {
  return (
    <Fieldset disabled={locked}>
      <Field>
        <Label>Name</Label>
        <Input />
      </Field>
      <Field>
        <Label>Notes</Label>
        <Textarea />
      </Field>
      <Field>
        <Label>Region</Label>
        <NativeSelect>
          <NativeSelectOption value="us">US</NativeSelectOption>
        </NativeSelect>
      </Field>
      <CheckboxField disabled={false}>
        <Checkbox disabled={false} />
        <Label>Notify</Label>
      </CheckboxField>
      <RadioGroup>
        <RadioField>
          <RadioGroupItem value="daily" />
          <Label>Daily</Label>
        </RadioField>
      </RadioGroup>
      <SwitchField>
        <Switch />
        <Label>Archived</Label>
      </SwitchField>
      <Field>
        <Button>Copy</Button>
      </Field>
    </Fieldset>
  );
}

const LABELS = ["Name", "Notes", "Region", "Notify", "Daily", "Archived"];

function labelled(doc: Document, text: string): Element | null {
  const label = [...doc.querySelectorAll("label")].find((node) => node.textContent === text);
  return label?.htmlFor ? doc.getElementById(label.htmlFor) : null;
}

describe("Field family", () => {
  test("labels point at their controls without htmlFor", async () => {
    const doc = await renderDocument(<DialogBody locked={false} />);
    expect(LABELS.map((text) => labelled(doc, text)?.tagName)).toEqual([
      "INPUT",
      "TEXTAREA",
      "SELECT",
      "INPUT",
      "INPUT",
      "INPUT",
    ]);
  });

  test("a disabled Fieldset disables every control, even ones passed disabled={false}", async () => {
    const doc = await renderDocument(<DialogBody locked />);
    expect(LABELS.map((text) => labelled(doc, text)?.matches(":disabled"))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      [...doc.querySelectorAll('[role="checkbox"], [role="radio"], [role="switch"]')].map(
        (control) => control.getAttribute("aria-disabled") ?? control.hasAttribute("data-disabled"),
      ),
    ).toEqual(["true", "true", "true"]);
    expect(doc.querySelector("button")?.matches(":disabled")).toBe(true);
  });

  test("an enabled Fieldset leaves every control enabled", async () => {
    const doc = await renderDocument(<DialogBody locked={false} />);
    expect(LABELS.map((text) => labelled(doc, text)?.matches(":disabled"))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(doc.querySelector("button")?.matches(":disabled")).toBe(false);
  });

  test("a disabled Fieldset marks its Legend, Label, Description, and ErrorMessage disabled so they dim", async () => {
    const render = (locked: boolean) =>
      renderDocument(
        <Fieldset disabled={locked}>
          <Legend>Scope</Legend>
          <Field>
            <Label>Retention</Label>
            <Description>1 to 3650 days.</Description>
            <Input />
            <ErrorMessage>Too long.</ErrorMessage>
          </Field>
        </Fieldset>,
      );
    const dimming = async (locked: boolean) => {
      const doc = await render(locked);
      return ["field-legend", "field-label", "field-description", "field-error"].map((slot) => {
        const node = doc.querySelector(`[data-slot="${slot}"]`);
        return [
          node?.hasAttribute("data-disabled"),
          node?.className.split(" ").includes("data-disabled:opacity-50"),
        ];
      });
    };
    expect([await dimming(true), await dimming(false)]).toEqual([
      [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
      ],
      [
        [false, true],
        [false, true],
        [false, true],
        [false, true],
      ],
    ]);
  });

  test("Label, Description, ErrorMessage, and Legend render outside a Field or Fieldset instead of throwing", async () => {
    const doc = await renderDocument(
      <>
        <Fieldset disabled>
          <Legend>Endpoint</Legend>
          <Description className="mt-3">Changing the endpoint re-runs discovery.</Description>
          <ErrorMessage>Enter an HTTPS URL.</ErrorMessage>
          <Label>Standalone</Label>
        </Fieldset>
        <Legend>Loose legend</Legend>
        <ErrorMessage>Form issue.</ErrorMessage>
      </>,
    );
    const parts = [...doc.querySelectorAll("[data-slot^=field-]")].map((node) => [
      node.getAttribute("data-slot"),
      node.tagName,
      node.textContent,
    ]);
    const fieldset = doc.querySelector('[data-slot="field-set"]');
    const classesIn = (scope: Element | null | undefined, slot: string) =>
      scope?.querySelector(`[data-slot="${slot}"]`)?.className.split(" ") ?? [];
    const dims = (slot: string) =>
      classesIn(fieldset, slot).includes("group-data-disabled/fieldset:opacity-50");
    expect({
      parts,
      fieldsetGroup: fieldset?.className.split(" ").includes("group/fieldset"),
      dimmed: [dims("field-label"), dims("field-description"), dims("field-error")],
      callerClass: classesIn(fieldset, "field-description").includes("mt-3"),
    }).toEqual({
      parts: [
        [
          "field-set",
          "FIELDSET",
          "EndpointChanging the endpoint re-runs discovery.Enter an HTTPS URL.Standalone",
        ],
        ["field-legend", "DIV", "Endpoint"],
        ["field-description", "P", "Changing the endpoint re-runs discovery."],
        ["field-error", "DIV", "Enter an HTTPS URL."],
        ["field-label", "LABEL", "Standalone"],
        ["field-legend", "DIV", "Loose legend"],
        ["field-error", "DIV", "Form issue."],
      ],
      fieldsetGroup: true,
      dimmed: [true, true, true],
      callerClass: true,
    });
  });

  test("outside a root each part keeps the classes it has inside one", async () => {
    const parts = (
      <>
        <Label>Name</Label>
        <Description>Shown in lists.</Description>
        <ErrorMessage>Too long.</ErrorMessage>
      </>
    );
    const inside = await renderDocument(
      <Fieldset>
        <Legend>Scope</Legend>
        <Field>{parts}</Field>
      </Fieldset>,
    );
    const outside = await renderDocument(
      <>
        <Legend>Scope</Legend>
        {parts}
      </>,
    );
    const fallbackOnly = "group-data-disabled/fieldset:opacity-50";
    const classes = (doc: Document, slot: string) =>
      (doc.querySelector(`[data-slot="${slot}"]`)?.className.split(" ") ?? [])
        .filter((name) => name !== fallbackOnly)
        .sort();
    const slots = ["field-legend", "field-label", "field-description", "field-error"];
    expect(slots.map((slot) => classes(outside, slot))).toEqual(
      slots.map((slot) => classes(inside, slot)),
    );
    expect(
      [
        ["field-legend", "font-semibold"],
        ["field-label", "font-medium"],
        ["field-description", "text-muted-foreground"],
        ["field-error", "text-destructive"],
      ].map(([slot = "", base = ""]) => classes(outside, slot).includes(base)),
    ).toEqual([true, true, true, true]);
  });

  test("inside their roots the parts still wire the legend, label, and descriptions", async () => {
    let wiring: unknown = undefined;
    await withClient(
      <Fieldset>
        <Legend>Server</Legend>
        <Field>
          <Label>Endpoint</Label>
          <Description>HTTPS only.</Description>
          <Input />
          <ErrorMessage>Enter an HTTPS URL.</ErrorMessage>
        </Field>
      </Fieldset>,
      async (view) => {
        const input = view.document.querySelector("input");
        const labelledBy = view.document.querySelector("fieldset")?.getAttribute("aria-labelledby");
        wiring = {
          legend: labelledBy ? view.document.getElementById(labelledBy)?.textContent : null,
          label: view.document.querySelector("label")?.htmlFor === input?.id,
          described: (input?.getAttribute("aria-describedby") ?? "")
            .split(" ")
            .map((id) => view.document.getElementById(id)?.textContent),
        };
      },
    );
    expect(wiring).toEqual({
      legend: "Server",
      label: true,
      described: ["HTTPS only.", "Enter an HTTPS URL."],
    });
  });

  test("a FieldGroup spaces vertical Fields 32px apart, and a SwitchField puts the switch right", async () => {
    const doc = await renderDocument(
      <FieldGroup>
        <Field>
          <Label>Name</Label>
          <Input />
        </Field>
        <SwitchField>
          <Label>Include curated models</Label>
          <Description>Adds every curated model.</Description>
          <Switch />
        </SwitchField>
      </FieldGroup>,
    );
    const classes = (slot: string) =>
      doc.querySelector(`[data-slot="${slot}"]`)?.className.split(" ") ?? [];
    const switchFieldNode = doc.querySelectorAll('[data-slot="field"]')[1];
    const switchField = switchFieldNode?.className.split(" ") ?? [];
    const placement = (slot: string) =>
      switchField
        .filter((name) => new RegExp(`^\\*:data-\\[slot=${slot}\\]:(col|row|pl)-`).test(name))
        .sort();
    expect({
      group: classes("field-group").filter((name) => /^gap-\d+$/.test(name)),
      switchField: ["grid", "grid-cols-[1fr_auto]", "w-auto", "w-full"].map((name) =>
        switchField.includes(name),
      ),
      label: placement("field-label"),
      description: placement("field-description"),
      switch: placement("switch"),
      children: [...(switchFieldNode?.children ?? [])]
        .filter((child) => child.tagName !== "INPUT")
        .map((child) => child.getAttribute("data-slot")),
    }).toEqual({
      group: ["gap-8"],
      switchField: [true, true, true, false],
      children: ["field-label", "field-description", "switch"],
      label: ["*:data-[slot=field-label]:col-start-1", "*:data-[slot=field-label]:row-start-1"],
      description: [
        "*:data-[slot=field-description]:col-start-1",
        "*:data-[slot=field-description]:pl-0",
        "*:data-[slot=field-description]:row-start-2",
      ],
      switch: ["*:data-[slot=switch]:col-start-2", "*:data-[slot=switch]:row-start-1"],
    });
  });
});
