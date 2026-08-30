/**
 * YAML 서브셋 파서 + 에미터.
 *
 * 왜 직접 만들었나: devkit의 설계 제약이 "의존성 0"이다(AGENTS.md §5). js-yaml을 붙이면
 * 이 서비스만 npm install이 필요해지고, 그 순간 에이전트가 툴을 고칠 수 없게 된다.
 *
 * 무엇을 지원하나 — 이 서비스가 실제로 읽어야 하는 두 종류의 문서에 맞춘다.
 *   1) public.yaml / 복호화된 secret.yaml — 블록 맵, 블록 시퀀스, 플로 시퀀스(alias), 스칼라, null
 *   2) 암호화된 secret.yaml — 위 + sops가 만드는 `enc: |` 리터럴 블록 (축소 모드에서
 *      개인키 없이도 평문 메타데이터를 읽어야 하므로 파싱 자체는 성공해야 한다, 스펙 §5.3)
 *
 * 무엇을 지원하지 않나: 앵커/별칭(&/*), 태그(!!), 멀티 문서(---), 복합 키(?).
 * 이 서비스가 쓰는 파일에는 나오지 않으며, 만나면 조용히 틀리는 대신 명시적으로 실패한다.
 */

export type YamlNode = null | string | number | boolean | YamlNode[] | { [k: string]: YamlNode };

export class YamlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (${line}행)`);
    this.name = 'YamlError';
    this.line = line;
  }
}

type Line = { indent: number; text: string; no: number };

class Reader {
  private raw: string[];
  private i = 0;

  constructor(text: string) {
    this.raw = text.replace(/\r\n?/g, '\n').split('\n');
  }

  /** 빈 줄과 전체 주석 줄을 건너뛴 뒤 현재 줄을 돌려준다(소비하지 않음). */
  peek(): Line | null {
    while (this.i < this.raw.length) {
      const t = this.raw[this.i];
      const trimmed = t.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        this.i++;
        continue;
      }
      return { indent: t.length - t.trimStart().length, text: trimmed, no: this.i + 1 };
    }
    return null;
  }

  /** peek 위치의 원본 줄. 시퀀스 아이템의 `- ` 뒤 열 위치를 계산할 때 쓴다. */
  peekRaw(): string {
    return this.raw[this.i];
  }

  next(): void {
    this.i++;
  }

  /** `- key: v`를 `key: v` 한 줄로 바꿔치기해 일반 경로로 재파싱시킨다. */
  replaceCurrent(text: string): void {
    this.raw[this.i] = text;
  }

  /** 리터럴/폴디드 블록 스칼라 본문을 원본 그대로 읽는다(주석·빈 줄 보존). */
  takeBlock(parentIndent: number): string[] {
    const body: string[] = [];
    while (this.i < this.raw.length) {
      const t = this.raw[this.i];
      if (t.trim() === '') {
        body.push('');
        this.i++;
        continue;
      }
      const indent = t.length - t.trimStart().length;
      if (indent <= parentIndent) break;
      body.push(t);
      this.i++;
    }
    // 뒤쪽 빈 줄은 블록에 속하지 않는다.
    while (body.length && body[body.length - 1] === '') body.pop();
    return body;
  }
}

export function parse(text: string): YamlNode {
  const r = new Reader(text);
  const first = r.peek();
  if (!first) return null;
  const node = parseNode(r, first.indent);
  const rest = r.peek();
  if (rest) throw new YamlError('문서 최상위에 정렬되지 않은 내용이 남았습니다', rest.no);
  return node;
}

function parseNode(r: Reader, indent: number): YamlNode {
  const l = r.peek();
  if (!l) return null;
  if (isSeqItem(l.text)) return parseSeq(r, indent);
  if (findKeyColon(l.text) >= 0) return parseMap(r, indent);
  r.next();
  return parseScalar(l.text, l.no);
}

function parseMap(r: Reader, indent: number): Record<string, YamlNode> {
  const obj: Record<string, YamlNode> = {};
  for (;;) {
    const l = r.peek();
    if (!l || l.indent < indent) break;
    if (l.indent > indent) throw new YamlError('들여쓰기가 맞지 않습니다', l.no);
    if (isSeqItem(l.text)) break; // 같은 들여쓰기의 시퀀스는 이 맵의 일부가 아니다

    const c = findKeyColon(l.text);
    if (c < 0) throw new YamlError(`맵 항목이 아닙니다: ${l.text.slice(0, 40)}`, l.no);
    const key = parseKey(l.text.slice(0, c), l.no);
    const rest = stripComment(l.text.slice(c + 1)).trim();
    r.next();

    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-') {
      obj[key] = parseBlockScalar(r, indent, rest);
    } else if (rest === '') {
      const nxt = r.peek();
      // `key:` 다음 줄이 더 깊거나, 같은 깊이의 시퀀스면 그게 이 키의 값이다.
      if (nxt && (nxt.indent > indent || (nxt.indent === indent && isSeqItem(nxt.text)))) {
        obj[key] = parseNode(r, nxt.indent);
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalar(rest, l.no);
    }
  }
  return obj;
}

function parseSeq(r: Reader, indent: number): YamlNode[] {
  const arr: YamlNode[] = [];
  for (;;) {
    const l = r.peek();
    if (!l || l.indent !== indent || !isSeqItem(l.text)) break;

    const raw = r.peekRaw();
    let j = indent + 1;
    while (j < raw.length && raw[j] === ' ') j++;

    if (j >= raw.length) {
      // `-` 단독 — 값은 다음 줄들에 있다.
      r.next();
      const nxt = r.peek();
      arr.push(nxt && nxt.indent > indent ? parseNode(r, nxt.indent) : null);
      continue;
    }
    // `- key: v` → `  key: v`로 바꾸면 나머지 줄들과 같은 열에 놓인다.
    r.replaceCurrent(' '.repeat(j) + raw.slice(j));
    arr.push(parseNode(r, j));
  }
  return arr;
}

function parseBlockScalar(r: Reader, parentIndent: number, style: string): string {
  const body = r.takeBlock(parentIndent);
  if (body.length === 0) return '';
  const contentIndent = Math.min(
    ...body.filter((b) => b.trim() !== '').map((b) => b.length - b.trimStart().length),
  );
  const lines = body.map((b) => b.slice(contentIndent));
  if (style.startsWith('>')) {
    // 폴디드: 빈 줄은 개행으로, 연속된 비어있지 않은 줄은 공백으로 접는다.
    const folded = lines.reduce((acc, cur, i) => {
      if (i === 0) return cur;
      if (cur === '' || acc.endsWith('\n')) return acc + '\n' + cur;
      return acc + ' ' + cur;
    }, '');
    return style.endsWith('-') ? folded : folded + '\n';
  }
  const joined = lines.join('\n');
  if (style === '|-') return joined;
  return joined + '\n';
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/**
 * 맵 키를 끝내는 `:`의 위치. 따옴표 안과 플로 컬렉션(`[]`/`{}`) 안은 건너뛴다.
 * `postgres://host:5432` 같은 값이 키로 오인되지 않게 하는 것이 핵심이다.
 */
function findKeyColon(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === '}') { depth--; continue; }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ')) return -1;
    if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

/** 값 뒤에 붙은 `# 주석`을 잘라낸다. 따옴표 안의 `#`은 값의 일부다. */
function stripComment(text: string): string {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === '}') { depth--; continue; }
    if (ch === '#' && depth === 0 && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

function parseKey(text: string, line: number): string {
  const t = text.trim();
  const s = parseScalar(t, line);
  if (typeof s === 'string') return s;
  if (s === null) throw new YamlError('빈 키는 지원하지 않습니다', line);
  return String(s);
}

function parseScalar(text: string, line: number): YamlNode {
  const t = stripComment(text).trim();
  if (t === '' || t === 'null' || t === '~' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (t.startsWith('"')) return unquoteDouble(t, line);
  if (t.startsWith("'")) return unquoteSingle(t, line);
  if (t.startsWith('[')) return parseFlowSeq(t, line);
  if (t.startsWith('{')) return parseFlowMap(t, line);
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError('앵커/별칭/태그는 지원하지 않습니다', line);
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function unquoteDouble(t: string, line: number): string {
  if (!t.endsWith('"') || t.length < 2) throw new YamlError('닫히지 않은 큰따옴표', line);
  try {
    return JSON.parse(t) as string;
  } catch {
    throw new YamlError('큰따옴표 문자열을 해석할 수 없습니다', line);
  }
}

function unquoteSingle(t: string, line: number): string {
  if (!t.endsWith("'") || t.length < 2) throw new YamlError('닫히지 않은 작은따옴표', line);
  return t.slice(1, -1).replace(/''/g, "'");
}

function splitFlow(inner: string, line: number): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"') { buf += inner[++i] ?? ''; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (quote) throw new YamlError('플로 컬렉션 안에 닫히지 않은 따옴표', line);
  if (buf.trim() !== '') parts.push(buf);
  return parts;
}

function parseFlowSeq(t: string, line: number): YamlNode[] {
  if (!t.endsWith(']')) throw new YamlError('닫히지 않은 플로 시퀀스', line);
  return splitFlow(t.slice(1, -1), line).map((p) => parseScalar(p.trim(), line));
}

function parseFlowMap(t: string, line: number): Record<string, YamlNode> {
  if (!t.endsWith('}')) throw new YamlError('닫히지 않은 플로 맵', line);
  const obj: Record<string, YamlNode> = {};
  for (const part of splitFlow(t.slice(1, -1), line)) {
    const c = findKeyColon(part.trim());
    if (c < 0) throw new YamlError('플로 맵 항목에 콜론이 없습니다', line);
    obj[parseKey(part.trim().slice(0, c), line)] = parseScalar(part.trim().slice(c + 1), line);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 에미터
// ---------------------------------------------------------------------------

/**
 * 모든 문자열을 큰따옴표로 감싸 출력한다.
 *
 * 평문 스칼라를 쓰지 않는 이유: `yes`, `no`, `on`, `12:30`, `0755`, `*star` 같은 값이
 * YAML 규칙에 따라 다른 타입으로 해석되거나 파싱 에러가 된다. 설정값에는 이런 문자열이
 * 실제로 들어온다(비밀번호에 `*`나 `#`가 흔하다). YAML의 큰따옴표 이스케이프는
 * JSON의 상위집합이므로 JSON.stringify를 그대로 쓸 수 있다.
 */
export function stringify(node: YamlNode, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (node === null) return 'null';
  if (typeof node === 'boolean') return String(node);
  if (typeof node === 'number') return String(node);
  if (typeof node === 'string') return JSON.stringify(node);
  if (Array.isArray(node)) {
    if (node.length === 0) return '[]';
    // 스칼라만 든 배열(alias)은 한 줄 플로로 — 사람이 읽기 좋고 예시 파일과도 같은 모양.
    if (node.every((n) => n === null || typeof n !== 'object')) {
      return `[${node.map((n) => stringify(n)).join(', ')}]`;
    }
    return node
      .map((n) => {
        // 스칼라 아이템은 들여쓰기를 만들지 않으므로 그대로 붙인다.
        if (n === null || typeof n !== 'object') return `${pad}- ${stringify(n)}`;
        // 맵/시퀀스 아이템은 indent+2에 렌더한 뒤, 첫 줄의 여백만 `- `로 바꿔 끼운다.
        const body = stringify(n, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      })
      .join('\n');
  }
  const entries = Object.entries(node);
  if (entries.length === 0) return '{}';
  const lines: string[] = [];
  for (const [k, v] of entries) {
    const key = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);
    if (v !== null && typeof v === 'object' && !isFlowable(v)) {
      lines.push(`${pad}${key}:`);
      lines.push(stringify(v, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${stringify(v, indent + 2)}`);
    }
  }
  return lines.join('\n');
}

function isFlowable(v: YamlNode): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.every((n) => n === null || typeof n !== 'object');
  return typeof v === 'object' && v !== null && Object.keys(v).length === 0;
}
