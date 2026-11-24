import { isDeepStrictEqual } from "node:util";

/**
 * Evaluates the DynamoDB condition and key-condition expression grammar the data layer emits:
 * comparisons, BETWEEN, IN, AND/OR/NOT, parentheses, and the attribute_exists,
 * attribute_not_exists, attribute_type, begins_with, contains, and size functions.
 */
export type DynamoItem = Readonly<Record<string, unknown>>;

export interface DynamoExpressionContext {
  readonly names?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, unknown>>;
}

type Token =
  | { readonly kind: "comparator"; readonly value: string }
  | { readonly kind: "keyword"; readonly value: "AND" | "BETWEEN" | "IN" | "NOT" | "OR" }
  | { readonly kind: "path"; readonly value: readonly (number | string)[] }
  | { readonly kind: "punctuation"; readonly value: "(" | ")" | "," }
  | { readonly kind: "value"; readonly value: string };

type Operand =
  | { readonly kind: "path"; readonly path: readonly (number | string)[] }
  | { readonly kind: "size"; readonly operand: Operand }
  | { readonly kind: "value"; readonly name: string };

const KEYWORDS = new Set(["AND", "BETWEEN", "IN", "NOT", "OR"]);

function tokenize(expression: string, context: DynamoExpressionContext): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const resolveName = (segment: string) => {
    if (!segment.startsWith("#")) return segment;
    const resolved = context.names?.[segment];
    if (resolved === undefined) throw new Error(`Unresolved expression attribute name ${segment}.`);
    return resolved;
  };
  while (index < expression.length) {
    const character = expression[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "(" || character === ")" || character === ",") {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }
    const comparator = /^(<>|<=|>=|=|<|>)/u.exec(expression.slice(index));
    if (comparator) {
      tokens.push({ kind: "comparator", value: comparator[1]! });
      index += comparator[1]!.length;
      continue;
    }
    if (character === ":") {
      const name = /^:[A-Za-z0-9_]+/u.exec(expression.slice(index))![0];
      tokens.push({ kind: "value", value: name });
      index += name.length;
      continue;
    }
    const path = /^[#A-Za-z_][A-Za-z0-9_]*(?:\.[#A-Za-z_][A-Za-z0-9_]*|\[\d+\])*/u.exec(
      expression.slice(index),
    );
    if (!path) throw new Error(`Unsupported expression syntax at "${expression.slice(index)}".`);
    const text = path[0];
    index += text.length;
    if (KEYWORDS.has(text.toUpperCase()) && !text.startsWith("#")) {
      tokens.push({ kind: "keyword", value: text.toUpperCase() as "AND" });
      continue;
    }
    const segments: (number | string)[] = [];
    for (const part of text.matchAll(/([#A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/gu)) {
      segments.push(part[2] === undefined ? resolveName(part[1]!) : Number(part[2]));
    }
    tokens.push({ kind: "path", value: segments });
  }
  return tokens;
}

function attributeType(value: unknown) {
  if (value === null) return "NULL";
  if (typeof value === "string") return "S";
  if (typeof value === "number") return "N";
  if (typeof value === "boolean") return "BOOL";
  if (Array.isArray(value)) return "L";
  if (value instanceof Uint8Array) return "B";
  if (value instanceof Set) {
    const first = [...value][0];
    return typeof first === "number" ? "NS" : typeof first === "string" ? "SS" : "BS";
  }
  return "M";
}

function compareOrdered(left: unknown, right: unknown) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return undefined;
}

class ExpressionParser {
  private position = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly item: DynamoItem | undefined,
    private readonly values: Readonly<Record<string, unknown>>,
  ) {}

  evaluate() {
    const result = this.or();
    if (this.position !== this.tokens.length) throw new Error("Unexpected trailing expression.");
    return result;
  }

  private peek() {
    return this.tokens[this.position];
  }

  private take() {
    const token = this.tokens[this.position];
    if (!token) throw new Error("Unexpected end of expression.");
    this.position += 1;
    return token;
  }

  private expect(kind: Token["kind"], value?: string) {
    const token = this.take();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected ${value ?? kind} in expression.`);
    }
    return token;
  }

  private isKeyword(value: string) {
    const token = this.peek();
    return token?.kind === "keyword" && token.value === value;
  }

  private or(): boolean {
    let result = this.and();
    while (this.isKeyword("OR")) {
      this.take();
      const right = this.and();
      result = result || right;
    }
    return result;
  }

  private and(): boolean {
    let result = this.not();
    while (this.isKeyword("AND")) {
      this.take();
      const right = this.not();
      result = result && right;
    }
    return result;
  }

  private not(): boolean {
    if (this.isKeyword("NOT")) {
      this.take();
      return !this.not();
    }
    return this.primary();
  }

  private operand(): Operand {
    const token = this.take();
    if (token.kind === "value") return { kind: "value", name: token.value };
    if (token.kind !== "path") throw new Error("Expected an expression operand.");
    if (token.value.length === 1 && token.value[0] === "size" && this.peek()?.value === "(") {
      this.take();
      const operand = this.operand();
      this.expect("punctuation", ")");
      return { kind: "size", operand };
    }
    return { kind: "path", path: token.value };
  }

  private resolve(operand: Operand): unknown {
    if (operand.kind === "value") {
      if (!(operand.name in this.values)) {
        throw new Error(`Unresolved expression attribute value ${operand.name}.`);
      }
      return this.values[operand.name];
    }
    if (operand.kind === "size") {
      const value = this.resolve(operand.operand);
      if (typeof value === "string" || Array.isArray(value)) return value.length;
      if (value instanceof Set) return value.size;
      if (value && typeof value === "object") return Object.keys(value).length;
      return undefined;
    }
    let current: unknown = this.item;
    for (const segment of operand.path) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string | number, unknown>)[segment];
    }
    return current;
  }

  private primary(): boolean {
    const token = this.peek();
    if (token?.kind === "punctuation" && token.value === "(") {
      this.take();
      const result = this.or();
      this.expect("punctuation", ")");
      return result;
    }
    if (
      token?.kind === "path" &&
      token.value.length === 1 &&
      this.tokens[this.position + 1]?.value === "("
    ) {
      const name = String(token.value[0]);
      if (name !== "size") return this.call(name);
    }
    const left = this.operand();
    const next = this.take();
    if (next.kind === "comparator") return this.compare(left, next.value, this.operand());
    if (next.kind === "keyword" && next.value === "BETWEEN") {
      const low = this.operand();
      this.expect("keyword", "AND");
      const high = this.operand();
      const value = this.resolve(left);
      const lower = compareOrdered(value, this.resolve(low));
      const upper = compareOrdered(value, this.resolve(high));
      return lower !== undefined && upper !== undefined && lower >= 0 && upper <= 0;
    }
    if (next.kind === "keyword" && next.value === "IN") {
      this.expect("punctuation", "(");
      const candidates = [this.operand()];
      while (this.peek()?.value === ",") {
        this.take();
        candidates.push(this.operand());
      }
      this.expect("punctuation", ")");
      const value = this.resolve(left);
      return candidates.some((candidate) => isDeepStrictEqual(value, this.resolve(candidate)));
    }
    throw new Error("Expected a comparison in expression.");
  }

  private compare(left: Operand, comparator: string, right: Operand) {
    const leftValue = this.resolve(left);
    const rightValue = this.resolve(right);
    if (comparator === "=") {
      return leftValue !== undefined && isDeepStrictEqual(leftValue, rightValue);
    }
    if (comparator === "<>") return !isDeepStrictEqual(leftValue, rightValue);
    const order = compareOrdered(leftValue, rightValue);
    if (order === undefined) return false;
    if (comparator === "<") return order < 0;
    if (comparator === "<=") return order <= 0;
    if (comparator === ">") return order > 0;
    return order >= 0;
  }

  private call(name: string) {
    this.take();
    this.expect("punctuation", "(");
    const args = [this.operand()];
    while (this.peek()?.value === ",") {
      this.take();
      args.push(this.operand());
    }
    this.expect("punctuation", ")");
    const [first, second] = args.map((argument) => this.resolve(argument));
    switch (name) {
      case "attribute_exists":
        return first !== undefined;
      case "attribute_not_exists":
        return first === undefined;
      case "attribute_type":
        return first !== undefined && attributeType(first) === second;
      case "begins_with":
        return typeof first === "string" && typeof second === "string" && first.startsWith(second);
      case "contains":
        if (typeof first === "string") return typeof second === "string" && first.includes(second);
        if (Array.isArray(first)) return first.some((entry) => isDeepStrictEqual(entry, second));
        if (first instanceof Set) return first.has(second);
        return false;
      default:
        throw new Error(`Unsupported expression function ${name}.`);
    }
  }
}

/** Tokenizes `expression` once and returns its predicate, so a query can test every item cheaply. */
export function dynamoExpression(expression: string, context: DynamoExpressionContext = {}) {
  const tokens = tokenize(expression, context);
  return (item: DynamoItem | undefined) =>
    new ExpressionParser(tokens, item, context.values ?? {}).evaluate();
}
