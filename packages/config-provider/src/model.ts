/**
 * 저장소 문서 모델 — YAML 노드 ↔ Item.
 *
 * 여기서 지키는 불변식은 두 가지다.
 *   1) 파일 위치가 visibility를 결정한다. YAML 안에 `visibility` 필드를 두지 않는다 —
 *      두면 "secret.yaml에 있는데 visibility: public" 같은 모순이 만들어질 수 있다.
 *   2) 파싱 실패는 조용히 넘어가지 않는다. 개인 설정 저장소에서 항목 하나가 조용히
 *      사라지면, 조회가 404를 내고 사람은 "키 이름을 잘못 알았나" 하고 엉뚱한 곳을 본다.
 */

import { DevkitError } from '#core/errors.ts';
import { parse, stringify, type YamlNode } from './yaml.ts';

export type Visibility = 'public' | 'secret';
export type ItemStatus = 'ok' | 'unset' | 'locked';

export type Item = {
  key: string;
  resourceType: string | null;
  alias: string[];
  /** env → 값. `null`은 "정의됐지만 미설정"(스펙 §4.8). 키 자체가 없으면 env 미정의. */
  value: Record<string, string | null>;
  desc: string | null;
  ref: string | null;
  /** 파일 위치로 결정되는 선언 visibility. 참조까지 반영한 실효값은 resolve.ts가 계산한다. */
  visibility: Visibility;
  /** 축소 모드: 암호문만 읽어 값이 없는 상태. 메타데이터는 정상. */
  locked: boolean;
};

const KNOWN_FIELDS = new Set(['key', 'resource_type', 'alias', 'value', 'desc', 'ref']);

export function parseDocument(text: string, visibility: Visibility, source: string, opts: { locked?: boolean } = {}): Item[] {
  let doc: YamlNode;
  try {
    doc = parse(text);
  } catch (err) {
    throw new DevkitError({
      code: 'CONFIG_PARSE_FAILED',
      message: `${source} 파싱 실패 — ${(err as Error).message}`,
      hint: 'YAML 서브셋만 지원합니다(앵커/별칭/멀티문서 불가). 파일을 열어 해당 행을 확인하세요.',
      retryable: false,
    });
  }
  if (doc === null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new DevkitError({
      code: 'CONFIG_PARSE_FAILED',
      message: `${source}의 최상위는 \`items:\` 키를 가진 맵이어야 합니다`,
      retryable: false,
    });
  }
  const raw = (doc as Record<string, YamlNode>).items;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new DevkitError({
      code: 'CONFIG_PARSE_FAILED',
      message: `${source}의 \`items\`는 시퀀스여야 합니다`,
      retryable: false,
    });
  }
  return raw.map((n, i) => toItem(n, visibility, `${source}#items[${i}]`, opts.locked === true));
}

function toItem(node: YamlNode, visibility: Visibility, at: string, locked: boolean): Item {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: 항목은 맵이어야 합니다`, retryable: false });
  }
  const m = node as Record<string, YamlNode>;

  for (const k of Object.keys(m)) {
    if (!KNOWN_FIELDS.has(k)) {
      throw new DevkitError({
        code: 'CONFIG_ITEM_INVALID',
        message: `${at}: 알 수 없는 필드 \`${k}\``,
        hint: `허용 필드: ${[...KNOWN_FIELDS].join(', ')}. 오타는 항목을 조용히 무의미하게 만듭니다.`,
        retryable: false,
      });
    }
  }

  const key = m.key;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: \`key\`는 비어있지 않은 문자열이어야 합니다`, retryable: false });
  }

  const alias: string[] = [];
  if (m.alias !== null && m.alias !== undefined) {
    if (!Array.isArray(m.alias)) {
      throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: \`alias\`는 시퀀스여야 합니다`, retryable: false });
    }
    for (const a of m.alias) {
      if (typeof a !== 'string') {
        throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: alias 원소는 문자열이어야 합니다`, retryable: false });
      }
      alias.push(a);
    }
  }

  const value: Record<string, string | null> = {};
  if (m.value !== null && m.value !== undefined) {
    if (typeof m.value !== 'object' || Array.isArray(m.value)) {
      throw new DevkitError({
        code: 'CONFIG_ITEM_INVALID',
        message: `${at}: \`value\`는 env를 키로 갖는 맵이어야 합니다 (예: value.prod / value.dev)`,
        retryable: false,
      });
    }
    for (const [env, v] of Object.entries(m.value as Record<string, YamlNode>)) {
      if (v === null) value[env] = null;
      else if (typeof v === 'string') value[env] = v;
      // YAML이 숫자/불린으로 해석한 값도 설정값으로는 문자열이다. 포트 번호가 대표적.
      else if (typeof v === 'number' || typeof v === 'boolean') value[env] = String(v);
      else {
        throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: value.${env}는 스칼라 또는 null이어야 합니다`, retryable: false });
      }
    }
  }

  return {
    key,
    resourceType: optionalString(m.resource_type, at, 'resource_type'),
    alias,
    value,
    desc: optionalString(m.desc, at, 'desc'),
    ref: optionalString(m.ref, at, 'ref'),
    visibility,
    locked,
  };
}

function optionalString(v: YamlNode, at: string, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new DevkitError({ code: 'CONFIG_ITEM_INVALID', message: `${at}: \`${field}\`는 문자열이어야 합니다`, retryable: false });
}

/** 정본 직렬화. 필드 순서를 고정해 git diff가 값 변경만 보여주게 한다. */
export function serializeDocument(items: Item[], header: string): string {
  const nodes = items.map((it) => {
    const o: Record<string, YamlNode> = { key: it.key };
    if (it.resourceType !== null) o.resource_type = it.resourceType;
    if (it.alias.length > 0) o.alias = it.alias;
    o.value = { ...it.value };
    if (it.desc !== null) o.desc = it.desc;
    if (it.ref !== null) o.ref = it.ref;
    return o;
  });
  return `${header}\n${stringify({ items: nodes })}\n`;
}

/**
 * 낙관적 잠금용 항목 버전.
 *
 * 값을 해시에 넣지 않는다 — secret 값이 해시 형태로라도 UI·MCP 응답에 실리면
 * 오프라인 대입 공격의 재료가 된다. alias/desc/ref/resource_type만으로 충분히
 * "내가 본 뒤로 남이 고쳤는가"를 판정할 수 있다.
 */
export function metaVersion(it: Item): string {
  const canon = JSON.stringify([it.key, it.resourceType, [...it.alias].sort(), it.desc, it.ref]);
  return fnv1a(canon);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
