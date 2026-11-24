import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { TextBudgetReached, TextSink } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";
import { readXmlEntry } from "./xml.ts";
import { InflationBudget, readZipDirectory } from "./zip.ts";

function readPart(xml: string, onText: (value: string) => void = () => {}) {
  const archive = readZipDirectory(zipSync({ "part.xml": strToU8(xml) }));
  const events: string[] = [];
  readXmlEntry(
    archive,
    archive.entries[0]!,
    {
      open: (name, attributes) => events.push(`<${name}${JSON.stringify(attributes)}`),
      text: (value) => {
        events.push(value);
        onText(value);
      },
      close: (name) => events.push(`</${name}`),
    },
    { sink: new TextSink(1024), inflation: new InflationBudget() },
  );
  return events;
}

const nested = (depth: number) => `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;

describe("XML part reader", () => {
  test("reports prefixed names, plain attributes, entities, and multi-byte text across inflate slices", () => {
    const charactersSharingUtf8LeadBytes = ["é", "è", "€", "₤"];
    let state = 1;
    const text = Array.from({ length: 65_536 }, () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return charactersSharingUtf8LeadBytes[(state >>> 0) % 4];
    }).join("");
    expect(
      readPart(`<?xml version="1.0"?><w:p w:val="x &amp; y"><w:t>${text}</w:t><w:br/></w:p>`).join(
        "",
      ),
    ).toBe(`<w:p{"w:val":"x & y"}<w:t{}${text}</w:t<w:br{}</w:br</w:p`);
  });

  test("aborts a part that declares a DOCTYPE even when no entity is used", () => {
    expect(() => readPart('<!DOCTYPE r [<!ENTITY e "boom">]><r>plain</r>')).toThrow(
      new UnusableFile("unreadable", "an XML part declares a DOCTYPE"),
    );
  });

  test("refuses undefined entities and malformed markup as unreadable", () => {
    const malformed = new UnusableFile("unreadable", "an XML part is malformed");
    expect(() => readPart("<r>&e;</r>")).toThrow(malformed);
    expect(() => readPart("<r><a></r>")).toThrow(malformed);
    expect(() => readPart("<r>")).toThrow(malformed);
  });

  test("allows 256 levels of nesting and refuses 257", () => {
    expect(readPart(nested(256))).toHaveLength(512);
    expect(() => readPart(nested(257))).toThrow(
      new UnusableFile("limits_exceeded", "an XML part nests deeper than 256 elements"),
    );
  });

  test("lets a full text sink stop the read unchanged", () => {
    const sink = new TextSink(4);
    expect(() => readPart("<r>first</r>", (value) => sink.write(value))).toThrow(TextBudgetReached);
    expect(new TextDecoder().decode(sink.bytes())).toBe("firs");
  });
});
