const TOKEN_CHARACTER = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

export interface AuthenticationChallenge {
  /** Auth-param names are lowercased; the first occurrence of a name wins. */
  readonly params: ReadonlyMap<string, string>;
  /** Lowercased auth scheme. */
  readonly scheme: string;
}

/**
 * Tolerant RFC 9110 §11.6.1 `WWW-Authenticate` parser: comma-separated challenges, each a
 * scheme followed by `name=token` / `name="quoted"` auth-params. Token68 credentials are
 * skipped; unquoted values end at whitespace or a comma.
 */
export function parseWwwAuthenticate(header: string): readonly AuthenticationChallenge[] {
  const challenges: AuthenticationChallenge[] = [];
  let position = 0;
  const skip = (characters: string) => {
    while (position < header.length && characters.includes(header[position]!)) position += 1;
  };
  const token = () => {
    const start = position;
    while (position < header.length && TOKEN_CHARACTER.test(header[position]!)) position += 1;
    return header.slice(start, position);
  };
  const paramAhead = () => {
    const start = position;
    const name = token();
    skip(" \t");
    const isParam = name.length > 0 && header[position] === "=";
    position = start;
    return isParam;
  };
  const value = () => {
    if (header[position] !== '"') {
      const start = position;
      while (position < header.length && !" \t,".includes(header[position]!)) position += 1;
      return header.slice(start, position);
    }
    position += 1;
    let quoted = "";
    while (position < header.length && header[position] !== '"') {
      if (header[position] === "\\" && position + 1 < header.length) position += 1;
      quoted += header[position];
      position += 1;
    }
    position += 1;
    return quoted;
  };

  while (position < header.length) {
    skip(" \t,");
    const scheme = token();
    if (!scheme) {
      position += 1;
      continue;
    }
    const params = new Map<string, string>();
    challenges.push({ params, scheme: scheme.toLowerCase() });
    skip(" \t");
    while (position < header.length) {
      if (!paramAhead()) {
        while (position < header.length && header[position] !== ",") position += 1;
        skip(" \t,");
        if (paramAhead()) continue;
        break;
      }
      const name = token().toLowerCase();
      skip(" \t");
      position += 1;
      skip(" \t");
      const parsed = value();
      if (!params.has(name)) params.set(name, parsed);
      skip(" \t");
      if (header[position] !== ",") break;
      skip(" \t,");
      if (!paramAhead()) break;
    }
  }
  return challenges;
}
