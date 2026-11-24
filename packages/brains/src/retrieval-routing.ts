export type BrainRetrievalMode = "brain-first" | "explicit" | "hybrid" | "memory-first" | "off";

export type KnowledgeRetrievalRoute = "both" | "brain" | "memory" | "neither";

export interface KnowledgeRetrievalPlan {
  readonly brainRequired: boolean;
  readonly reasons: readonly string[];
  readonly route: KnowledgeRetrievalRoute;
  readonly unmetEvidenceRequirement: boolean;
}

const brainSignalPatterns = [
  [
    "citation-request",
    /\b(cite|citations?|sources?|evidence|supporting|original wording|verbatim)\b/iu,
  ],
  ["history-or-causality", /\b(why|when|what changed|decision|history|timeline)\b/iu],
  ["institutional-entity", /\b(company|customer|project|meeting|document|contract|deal)\b/iu],
  ["current-or-complete", /\b(current|latest|up[- ]to[- ]date|complete|all records)\b/iu],
  ["explicit-brain", /\b(brain|knowledge base|source document)\b/iu],
  ["high-risk-domain", /\b(legal|financial|finance|hr|security|compliance|regulatory)\b/iu],
] as const;

const memorySignalPatterns = [
  ["preference", /\b(my preference|i prefer|i like|my style|standing instruction)\b/iu],
  ["conversation-continuity", /\b(earlier|previously|last time|we discussed|continue)\b/iu],
  ["learned-procedure", /\b(how i usually|our usual workflow|remember how|learned procedure)\b/iu],
  ["agent-context", /\b(your instructions|your role|operating context)\b/iu],
  ["user-recall", /\b(i said|i told you|remember that i)\b/iu],
] as const;

function signals(query: string, patterns: readonly (readonly [string, RegExp])[]) {
  return patterns.flatMap(([reason, pattern]) => (pattern.test(query) ? [reason] : []));
}

function chooseAvailable(
  wantsBrain: boolean,
  wantsMemory: boolean,
  hasBrains: boolean,
  hasMemory: boolean,
): KnowledgeRetrievalRoute {
  const brain = wantsBrain && hasBrains;
  const memory = wantsMemory && hasMemory;
  if (brain && memory) return "both";
  if (brain) return "brain";
  if (memory) return "memory";
  return "neither";
}

export function planKnowledgeRetrieval(input: {
  readonly authorizedBrainCount: number;
  readonly explicitBrain?: boolean;
  readonly explicitMemory?: boolean;
  readonly hasMemory: boolean;
  readonly memoryConfidence?: number;
  readonly memoryConflicting?: boolean;
  readonly memoryExpired?: boolean;
  readonly memoryWeaklySourced?: boolean;
  readonly mode: BrainRetrievalMode;
  readonly query: string;
}): KnowledgeRetrievalPlan {
  if (input.mode === "off") {
    return {
      brainRequired: false,
      reasons: ["retrieval-off"],
      route: "neither",
      unmetEvidenceRequirement: false,
    };
  }
  const brainReasons = signals(input.query, brainSignalPatterns);
  const memoryReasons = signals(input.query, memorySignalPatterns);
  if (input.explicitBrain) brainReasons.push("explicit-brain-tool");
  if (input.explicitMemory) memoryReasons.push("explicit-memory-tool");
  const brainRequired = brainReasons.some(
    (reason) => reason === "citation-request" || reason === "high-risk-domain",
  );
  const memoryUnreliable =
    input.memoryExpired === true ||
    input.memoryConflicting === true ||
    input.memoryWeaklySourced === true ||
    (input.memoryConfidence !== undefined && input.memoryConfidence < 0.5);
  if (memoryUnreliable) brainReasons.push("memory-escalation");

  let wantsBrain = brainReasons.length > 0;
  let wantsMemory = memoryReasons.length > 0;
  switch (input.mode) {
    case "explicit":
      wantsBrain = input.explicitBrain === true || brainRequired;
      wantsMemory = input.explicitMemory === true;
      break;
    case "brain-first":
      wantsBrain = true;
      break;
    case "memory-first":
      wantsMemory = true;
      wantsBrain = wantsBrain || memoryUnreliable;
      break;
    case "hybrid":
      wantsBrain = wantsBrain || wantsMemory;
      wantsMemory = wantsMemory || brainReasons.length === 0;
      break;
  }
  if (brainRequired) wantsBrain = true;
  const hasBrains = input.authorizedBrainCount > 0;
  const route = chooseAvailable(wantsBrain, wantsMemory, hasBrains, input.hasMemory);
  return {
    brainRequired,
    reasons: [...brainReasons, ...memoryReasons],
    route,
    unmetEvidenceRequirement: brainRequired && (route === "memory" || route === "neither"),
  };
}

export function composeKnowledgeContext(input: {
  readonly brainEvidence?: string;
  readonly memory?: string;
}) {
  return [
    ...(input.memory?.trim()
      ? [`<memory_context>\n${input.memory.trim()}\n</memory_context>`]
      : []),
    ...(input.brainEvidence?.trim()
      ? [
          `<brain_evidence source_grounded="true">\n${input.brainEvidence.trim()}\n</brain_evidence>`,
        ]
      : []),
  ].join("\n\n");
}
