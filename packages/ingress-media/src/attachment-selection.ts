import {
  inputFileHint,
  MAX_INPUT_ARTIFACT_BYTES,
  MAX_INPUT_ARTIFACTS,
} from "@deployments-ai/agent-manifest";

export const MAX_INGRESS_IMAGES_PER_TURN = 4;
export const MAX_INGRESS_DOCUMENTS_PER_TURN = MAX_INPUT_ARTIFACTS - MAX_INGRESS_IMAGES_PER_TURN;

const TURN_CAPS = {
  document: MAX_INGRESS_DOCUMENTS_PER_TURN,
  image: MAX_INGRESS_IMAGES_PER_TURN,
} as const satisfies Record<string, number>;

type IngressAttachmentFamily = keyof typeof TURN_CAPS;

export type IngressAttachmentIdentity =
  | {
      readonly externalMessageId: string;
      readonly ordinal: number;
      readonly type: "channel-attachment";
    }
  | { readonly emailAttachmentId: string; readonly type: "email-attachment" };

export interface IngressAttachmentCandidate<Reference> {
  readonly declared: {
    readonly byteSize?: number;
    readonly contentType?: string;
    readonly fileName?: string;
    readonly kind?: string;
  };
  readonly identity: IngressAttachmentIdentity;
  readonly reference: Reference;
}

export type IngressSkipReason =
  | "legacy_office_format"
  | "over_turn_cap"
  | "too_large"
  | "unsupported_type";

export interface IngressSkippedAttachment {
  readonly identity: IngressAttachmentIdentity;
  readonly name: string;
  readonly reason: IngressSkipReason;
}

export interface IngressAttachmentOffer<Reference> {
  readonly candidate: IngressAttachmentCandidate<Reference>;
  readonly name: string;
}

export interface IngressAttachmentSelection<Reference> {
  readonly offered: readonly IngressAttachmentOffer<Reference>[];
  readonly skipped: readonly IngressSkippedAttachment[];
}

const MAX_NAME_CHARACTERS = 255;

function attachmentName(fileName: string | undefined, position: number) {
  const name = Array.from(fileName?.trim() ?? "")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "/" || character === "\\" || code <= 0x1f || code === 0x7f
        ? "_"
        : character;
    })
    .slice(0, MAX_NAME_CHARACTERS)
    .join("");
  return name && name !== "." && name !== ".." ? name : `attachment-${position}`;
}

function familyOf(
  declared: IngressAttachmentCandidate<unknown>["declared"],
): IngressAttachmentFamily | Exclude<IngressSkipReason, "over_turn_cap" | "too_large"> {
  const hint = inputFileHint(declared);
  switch (hint?.kind) {
    case "document":
    case "image":
      return hint.kind;
    case "unsupported":
      return hint.reason === "legacy_office_format" ? hint.reason : "unsupported_type";
    case "audio":
      return "unsupported_type";
    case undefined:
      return declared.contentType === undefined && declared.kind === "image"
        ? "image"
        : "unsupported_type";
    default: {
      const unhandled: never = hint;
      return unhandled;
    }
  }
}

export function selectIngressAttachments<Reference>(
  candidates: readonly IngressAttachmentCandidate<Reference>[],
): IngressAttachmentSelection<Reference> {
  const offered: IngressAttachmentOffer<Reference>[] = [];
  const skipped: IngressSkippedAttachment[] = [];
  const taken: Record<IngressAttachmentFamily, number> = { document: 0, image: 0 };
  for (const [index, candidate] of candidates.entries()) {
    const name = attachmentName(candidate.declared.fileName, index + 1);
    const family = familyOf(candidate.declared);
    const skip = (reason: IngressSkipReason) =>
      skipped.push({ identity: candidate.identity, name, reason });
    if (family !== "document" && family !== "image") skip(family);
    else if ((candidate.declared.byteSize ?? 0) > MAX_INPUT_ARTIFACT_BYTES) skip("too_large");
    else if (taken[family] >= TURN_CAPS[family]) skip("over_turn_cap");
    else {
      taken[family] += 1;
      offered.push({ candidate, name });
    }
  }
  return { offered, skipped };
}
