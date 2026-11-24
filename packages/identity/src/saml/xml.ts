import { DOMParser, Element, type Document } from "@xmldom/xmldom";

export const SAML_PROTOCOL_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:protocol";
export const SAML_ASSERTION_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:assertion";
export const SAML_METADATA_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:metadata";
export const XMLDSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";

export type XmlDefect = "xml_malformed" | "doctype_forbidden";

export type XmlParse =
  | { readonly kind: "parsed"; readonly document: Document }
  | { readonly kind: "rejected"; readonly defect: XmlDefect };

/**
 * xmldom never expands entities, but it keeps the DOCTYPE and reports unknown entity references as
 * non-fatal errors, so the DOCTYPE check runs before the collected errors are judged.
 */
export function parseXml(xml: string): XmlParse {
  let errorCount = 0;
  let document: Document;
  try {
    document = new DOMParser({
      onError: (level) => {
        if (level !== "warning") errorCount += 1;
      },
    }).parseFromString(xml, "text/xml");
  } catch {
    return { defect: "xml_malformed", kind: "rejected" };
  }
  if (document.doctype !== null) return { defect: "doctype_forbidden", kind: "rejected" };
  if (errorCount > 0 || document.documentElement === null) {
    return { defect: "xml_malformed", kind: "rejected" };
  }
  return { document, kind: "parsed" };
}

export function isElementNamed(element: Element, namespace: string, localName: string): boolean {
  return element.namespaceURI === namespace && element.localName === localName;
}

export function childElements(parent: Element, namespace: string, localName: string): Element[] {
  const children: Element[] = [];
  for (const child of parent.childNodes) {
    if (child instanceof Element && isElementNamed(child, namespace, localName)) {
      children.push(child);
    }
  }
  return children;
}

export function onlyChild(
  parent: Element,
  namespace: string,
  localName: string,
): Element | undefined {
  const children = childElements(parent, namespace, localName);
  return children.length === 1 ? children[0] : undefined;
}

export function attributeValue(element: Element, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null;
}

const XML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeXml(value: string): string {
  return value.replace(/["&'<>]/gu, (character) => XML_ESCAPES[character] ?? character);
}
