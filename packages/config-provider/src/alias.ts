/**
 * Alias 인덱스 (스펙 §4.3 / §4.5).
 *
 * 이 서비스의 절반은 "값을 안전하게 주는 것"이고, 나머지 절반은 "이름을 기억 못 해도
 * 찾게 하는 것"이다. 후자가 alias다. 검색 결과에는 **값을 절대 싣지 않는다** —
 * 그 덕분에 secret 항목까지 같은 인덱스에 넣어도 안전하고, 에이전트는
 * resolve_alias → get_value 2단계로만 값에 닿을 수 있다.
 */

import { DevkitError } from '#core/errors.ts';
import type { Item, Visibility } from './model.ts';
import { maxVisibility, type Index } from './resolve.ts';

/**
 * 매칭 정규화: NFC 정규화 → 소문자 → 공백/하이픈/밑줄 제거.
 * "입고 지시", "입고지시", "INBOUND-INSTRUCTION"이 모두 같은 키로 모인다.
 * 표시용 원본 문자열은 그대로 보존한다(스펙 §4.5).
 */
export function normalize(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s_-]+/g, '');
}

export type SearchHit = {
  key: string;
  alias: string[];
  /** 어떤 alias가 걸렸는지 — 사람이 "아 그거" 하고 확인할 수 있게 한다. */
  matched: string;
  resourceType: string | null;
  desc: string | null;
  /** 참조까지 반영한 보수적 민감도. secret이면 값 조회에 화이트리스트가 걸린다. */
  visibility: Visibility;
  /** 어떤 env에 값이 정의되어 있는지. 값 자체는 포함하지 않는다. */
  envs: string[];
  score: number;
};

/**
 * 두 파일을 합쳐 key 인덱스를 만든다.
 * key/alias 중복은 **기동 실패**로 다룬다 — 조용한 우선순위 규칙을 두면 secret 항목이
 * 동명의 public 항목에 가려져 엉뚱한 값이 나가는 사고가 생긴다(스펙 §4.1).
 */
export function buildIndex(items: Item[]): Index {
  const index: Index = new Map();
  const aliasOwner = new Map<string, string>();

  for (const it of items) {
    const prev = index.get(it.key);
    if (prev) {
      throw new DevkitError({
        code: 'CONFIG_DUPLICATE_KEY',
        message: `key \`${it.key}\`가 ${prev.visibility}.yaml과 ${it.visibility}.yaml 양쪽에 있습니다`,
        hint: '두 파일 전체에서 key는 유일해야 합니다. 한쪽을 지우거나 이름을 바꾸세요.',
        retryable: false,
      });
    }
    index.set(it.key, it);
  }

  for (const it of items) {
    for (const a of it.alias) {
      const n = normalize(a);
      if (n === '') {
        throw new DevkitError({
          code: 'CONFIG_ALIAS_EMPTY',
          message: `${it.key}에 빈 alias가 있습니다`,
          retryable: false,
        });
      }
      const owner = aliasOwner.get(n);
      if (owner && owner !== it.key) {
        throw new DevkitError({
          code: 'CONFIG_DUPLICATE_ALIAS',
          message: `alias \`${a}\`를 ${owner}와 ${it.key}가 함께 씁니다`,
          hint: '같은 자연어가 두 리소스를 가리키면 에이전트가 틀린 값을 조회합니다. 한쪽을 바꾸세요.',
          retryable: false,
        });
      }
      aliasOwner.set(n, it.key);
    }
  }

  return index;
}

/** 이미 다른 key가 쓰는 alias인지 확인한다. 자기 자신은 충돌이 아니다. */
export function findAliasOwner(alias: string, index: Index, exceptKey?: string): string | null {
  const n = normalize(alias);
  for (const it of index.values()) {
    if (it.key === exceptKey) continue;
    if (it.alias.some((a) => normalize(a) === n)) return it.key;
  }
  return null;
}

/**
 * 부분 매치 검색. 의미 기반(임베딩) 검색은 1차 범위 밖이므로(스펙 §6),
 * 정규화 + 부분 문자열 + 토큰 단위 매치까지만 한다.
 */
export function search(query: string, index: Index, limit = 10): SearchHit[] {
  const q = normalize(query);
  if (q === '') {
    throw new DevkitError({ code: 'QUERY_EMPTY', message: '검색어가 비었습니다', retryable: false });
  }
  const tokens = query.normalize('NFC').toLowerCase().split(/[\s_-]+/).filter(Boolean).map(normalize);

  const hits: SearchHit[] = [];
  for (const it of index.values()) {
    let best = 0;
    let matched = '';

    for (const a of it.alias) {
      const s = scoreOne(q, tokens, normalize(a));
      if (s > best) { best = s; matched = a; }
    }
    const ks = scoreOne(q, tokens, normalize(it.key)) * 0.9; // key 직접 매치는 alias보다 살짝 낮게
    if (ks > best) { best = ks; matched = it.key; }

    if (it.desc) {
      const ds = normalize(it.desc).includes(q) ? 0.3 : 0;
      if (ds > best) { best = ds; matched = it.desc; }
    }

    if (best > 0) {
      hits.push({
        key: it.key,
        alias: it.alias,
        matched,
        resourceType: it.resourceType,
        desc: it.desc,
        visibility: maxVisibility(it.key, index),
        envs: Object.keys(it.value),
        score: Number(best.toFixed(3)),
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit);
}

function scoreOne(q: string, tokens: string[], target: string): number {
  if (target === '') return 0;
  if (target === q) return 1;
  if (target.startsWith(q) || q.startsWith(target)) return 0.8;
  if (target.includes(q) || q.includes(target)) return 0.6;
  // 검색어 토큰이 전부 들어있으면 부분 점수 — "입고 토픽" 같은 조합 질의를 살린다.
  if (tokens.length > 1 && tokens.every((t) => target.includes(t))) return 0.5;
  return 0;
}
