export const RESTORE_BYTES = 80 * 1024 * 1024;
export const backupJsonLimits = {
  depth: 64,
  tokens: 12_000_000,
  stringUnits: 1024 * 1024,
  literalUnits: 128,
};

const syntaxError = () => new SyntaxError("백업 JSON의 구조 또는 이스케이프가 잘못되었습니다.");

/** Bound allocations before JSON.parse. JSON.parse remains the grammar validator. */
export function checkBackupJson(text: string, limits = backupJsonLimits) {
  let tokens = 0;
  const containers: string[] = [];
  const whitespace = (ch: string) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
  const punctuation = (ch: string) => ch === "," || ch === ":" || ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === '"';
  for (let i = 0; i < text.length;) {
    const ch = text[i++];
    if (whitespace(ch) || ch === "," || ch === ":") continue;
    if (ch === "}" || ch === "]") {
      if (containers.pop() !== (ch === "}" ? "{" : "[")) throw syntaxError();
      continue;
    }
    if (++tokens > limits.tokens)
      throw new Error("백업 JSON 토큰 한도를 초과했습니다. 프로젝트를 나누세요.");
    if (ch === "{" || ch === "[") {
      if (containers.length >= limits.depth)
        throw new Error("백업 JSON 중첩 깊이 한도를 초과했습니다.");
      containers.push(ch);
      continue;
    }
    if (ch === '"') {
      let units = 0;
      while (i < text.length && text[i] !== '"') {
        if (++units > limits.stringUnits)
          throw new Error("백업 JSON 문자열 길이 한도를 초과했습니다.");
        const next = text[i++];
        if (next.charCodeAt(0) < 32) throw syntaxError();
        if (next !== "\\") continue;
        const escape = text[i++];
        if (escape === "u") {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(i, i + 4))) throw syntaxError();
          i += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) throw syntaxError();
      }
      if (text[i++] !== '"') throw syntaxError();
      continue;
    }
    const start = i - 1;
    while (i < text.length && !whitespace(text[i]) && !punctuation(text[i])) {
      if (++i - start > limits.literalUnits)
        throw new Error("백업 JSON 숫자 또는 리터럴 길이 한도를 초과했습니다.");
    }
  }
  if (containers.length) throw syntaxError();
}

export const RESTORE_WORK_LIMIT = 30_000_000;

/** Include opaque settings and descriptive text when the same record is replayed. */
export function restoreValueWork(value: unknown): number {
  let work = 0;
  function visit(item: unknown) {
    if (work > RESTORE_WORK_LIMIT) return;
    work++;
    if (typeof item === "string") work += Math.ceil(item.length / 32);
    else if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
        if (work > RESTORE_WORK_LIMIT) break;
      }
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        work += Math.ceil(key.length / 32);
        visit(child);
        if (work > RESTORE_WORK_LIMIT) break;
      }
    }
  }
  visit(value);
  return Math.min(work, RESTORE_WORK_LIMIT + 1);
}

export function restoreBudget() {
  let remaining = RESTORE_WORK_LIMIT;
  return (units: number, phase: string) => {
    remaining -= units;
    if (units < 0 || !Number.isSafeInteger(remaining) || remaining < 0)
      throw new Error(`프로젝트 누적 복원 검증 한도를 초과했습니다 (${phase}). 버전·작업 또는 그래프를 나누세요.`);
  };
}
