import { describe, expect, test } from "bun:test";
import { act, useState, type ComponentProps } from "react";
import { Field, Fieldset, Label } from "@/components/ui/field";
import { FileInput, formatFileSize } from "@/components/ui/file-input";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";

const json = new File(["{}"], "cases.json", { type: "application/json" });
const big = new File([new Uint8Array(2048)], "big.json", { type: "application/json" });
const script = new File(["x"], "run.ts", { type: "video/mp2t" });
const image = new File(["x"], "logo.png", { type: "image/png" });

type Rules = Pick<ComponentProps<typeof FileInput>, "accept" | "maxSize" | "multiple">;

/** A controlled FileInput that logs each callback in the order it fires. */
function Picker({
  initial,
  log,
  rules,
}: {
  initial: readonly File[];
  log: unknown[];
  rules: Rules;
}) {
  const [value, setValue] = useState(initial);
  return (
    <FileInput
      {...rules}
      onChange={(files) => {
        log.push(["change", files.map((file) => file.name)]);
        setValue(files);
      }}
      onReject={(rejections) =>
        log.push(["reject", rejections.map(({ file, reason }) => [file.name, reason])])
      }
      value={value}
    />
  );
}

const selection = (view: ClientView) =>
  [...view.document.querySelectorAll('[aria-label="Selected files"] li button')].map((button) =>
    button.getAttribute("aria-label")?.replace(/^Remove /, ""),
  );

const fileInput = (view: ClientView) => {
  const input = view.document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
};

async function choose(view: ClientView, files: File[]) {
  const input = fileInput(view);
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function drag(view: ClientView, type: "dragenter" | "drop", files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "none", files } });
  await act(async () => {
    fileInput(view).dispatchEvent(event);
  });
}

/** Picks each batch in turn and returns the callback log and the rendered selection. */
async function pickBatches(rules: Rules, initial: readonly File[], batches: File[][]) {
  const log: unknown[] = [];
  let shown: unknown[] = [];
  await withClient(<Picker initial={initial} log={log} rules={rules} />, async (view) => {
    for (const batch of batches) await choose(view, batch);
    shown = selection(view);
  });
  return { log, shown };
}

describe("FileInput selection rules", () => {
  test("rejects files outside accept or over maxSize, reporting the accepted file first", async () => {
    expect(
      await pickBatches(
        { accept: ".json,application/json", maxSize: 1024 },
        [],
        [[json, big, script]],
      ),
    ).toEqual({
      log: [
        ["change", ["cases.json"]],
        [
          "reject",
          [
            ["big.json", "size"],
            ["run.ts", "accept"],
          ],
        ],
      ],
      shown: ["cases.json"],
    });
  });

  test("matches type wildcards and extensions case-insensitively", async () => {
    expect(
      await pickBatches({ accept: "image/*, .TS", multiple: true }, [], [[image, script]]),
    ).toEqual({ log: [["change", ["logo.png", "run.ts"]]], shown: ["logo.png", "run.ts"] });
  });

  test("with multiple, a pick appends to the selection", async () => {
    expect((await pickBatches({ multiple: true }, [json], [[image, script]])).shown).toEqual([
      "cases.json",
      "logo.png",
      "run.ts",
    ]);
  });

  test("without multiple, a pick replaces the selection with its first accepted file", async () => {
    expect(await pickBatches({}, [json], [[image, script]])).toEqual({
      log: [["change", ["logo.png"]]],
      shown: ["logo.png"],
    });
  });

  test("without multiple, a pick with nothing accepted keeps the selection", async () => {
    expect(await pickBatches({ accept: ".png" }, [json], [[script]])).toEqual({
      log: [["reject", [["run.ts", "accept"]]]],
      shown: ["cases.json"],
    });
  });

  test("with multiple, a file already selected or picked twice in one batch is kept once", async () => {
    const again = new File(["{}"], "cases.json", {
      lastModified: json.lastModified,
      type: "application/json",
    });
    expect([
      await pickBatches({ multiple: true }, [json], [[again, image]]),
      await pickBatches({ multiple: true }, [], [[image, image]]),
      await pickBatches({ multiple: true }, [json], [[again]]),
    ]).toEqual([
      { log: [["change", ["cases.json", "logo.png"]]], shown: ["cases.json", "logo.png"] },
      { log: [["change", ["logo.png"]]], shown: ["logo.png"] },
      { log: [], shown: ["cases.json"] },
    ]);
  });

  test("a drop follows the same rules and shows the drop prompt while dragging", async () => {
    const log: unknown[] = [];
    const steps: unknown[] = [];
    await withClient(
      <Picker initial={[]} log={log} rules={{ accept: ".json", multiple: true }} />,
      async (view) => {
        const prompt = () => view.document.querySelector(".font-medium")?.textContent;
        await drag(view, "dragenter");
        steps.push(prompt());
        await drag(view, "drop", [json, image]);
        steps.push(prompt(), selection(view));
      },
    );
    expect({ log, steps }).toEqual({
      log: [
        ["change", ["cases.json"]],
        ["reject", [["logo.png", "accept"]]],
      ],
      steps: ["Drop to upload", "Choose a file or drag it here", ["cases.json"]],
    });
  });

  test("a disabled Fieldset ignores drops", async () => {
    const log: unknown[] = [];
    await withClient(
      <Fieldset disabled>
        <Picker initial={[]} log={log} rules={{}} />
      </Fieldset>,
      async (view) => {
        await drag(view, "drop", [json]);
      },
    );
    expect(log).toEqual([]);
  });

  test("a remove button drops its file from the selection", async () => {
    const log: unknown[] = [];
    let shown: unknown[] = [];
    await withClient(
      <Picker initial={[json, image]} log={log} rules={{ multiple: true }} />,
      async (view) => {
        await view.click(view.document.querySelector('[aria-label="Remove cases.json"]'));
        shown = selection(view);
      },
    );
    expect({ log, shown }).toEqual({ log: [["change", ["logo.png"]]], shown: ["logo.png"] });
  });
});

describe("FileInput", () => {
  test("describes accepted types and size limit unless a hint is given", async () => {
    const doc = await renderDocument(
      <>
        <FileInput
          accept=".json, application/json"
          maxSize={1024 * 1024}
          onChange={() => {}}
          value={[]}
        />
        <FileInput hint="TypeScript or Python, up to 1 MB" onChange={() => {}} value={[]} />
      </>,
    );
    expect(
      [...doc.querySelectorAll('[data-slot="file-input-hint"]')].map((node) => node.textContent),
    ).toEqual([".json, application/json · up to 1.0 MB", "TypeScript or Python, up to 1 MB"]);
  });

  test("lists the selection with type icons, sizes, and remove buttons", async () => {
    const doc = await renderDocument(
      <FileInput multiple onChange={() => {}} value={[json, big]} />,
    );
    expect(
      [...doc.querySelectorAll('[aria-label="Selected files"] li')].map((row) => [
        row.querySelector('[data-slot="file-type"]')?.getAttribute("data-type"),
        row.textContent,
        row.querySelector("button")?.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["json", "JSONcases.json2 B", "Remove cases.json"],
      ["json", "JSONbig.json2.0 KB", "Remove big.json"],
    ]);
    expect(doc.querySelector('input[type="file"]')?.hasAttribute("multiple")).toBe(true);
  });

  test("a disabled Fieldset disables the input and its remove buttons, and the label wires", async () => {
    const doc = await renderDocument(
      <Fieldset disabled>
        <Field>
          <Label>Files</Label>
          <FileInput onChange={() => {}} value={[json]} />
        </Field>
      </Fieldset>,
    );
    const input = doc.querySelector('input[type="file"]');
    const label = doc.querySelector("label");
    expect({
      labelled: label?.htmlFor === input?.id && input?.id !== "",
      input: input?.matches(":disabled"),
      remove: doc.querySelector("li button")?.matches(":disabled"),
    }).toEqual({ labelled: true, input: true, remove: true });
  });

  test("formatFileSize rounds to the largest unit", () => {
    expect([formatFileSize(512), formatFileSize(1536), formatFileSize(25 * 1024 * 1024)]).toEqual([
      "512 B",
      "1.5 KB",
      "25 MB",
    ]);
  });
});
