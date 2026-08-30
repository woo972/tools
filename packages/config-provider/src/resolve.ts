/**
 * 참조 해석 + 실효 visibility (스펙 §4.7).
 *
 * 이 파일이 이 서비스에서 가장 위험한 코드다. 스펙 §6이 지목한 취약점이 여기 있다:
 * public 항목이 `{{DB_PASSWORD}}`를 참조하면 치환 결과물은 secret인데, 이 전파를
 * 놓치면 secret이 화이트리스트를 우회해 저위험 경로(alias 검색·기본 허용 key)로 샌다.
 *
 * 그래서 두 가지를 구조로 못박았다.
 *   - 값을 만드는 유일한 함수(resolveValue)가 실효 visibility를 **같이** 반환한다.
 *     값만 받아가고 민감도는 잊어버리는 호출을 타입 수준에서 불가능하게 한다.
 *   - env를 넘나드는 참조를 아예 지원하지 않는다. dev 조회가 prod 비밀번호를 끌어올
 *     경로 자체를 없앤다.
 */

import { DevkitError } from '#core/errors.ts';
import type { Item, ItemStatus, Visibility } from './model.ts';

/** 참조 중첩 상한. 이보다 깊으면 사람이 이해할 수 없는 설정이고, 대개 실수다. */
export const MAX_DEPTH = 5;

type Token = { lit: string } | { ref: string };

/**
 * 템플릿을 토큰으로 분해한다.
 * `{{{{` / `}}}}` 는 리터럴 중괄호 두 개로 이스케이프된다.
 */
export function tokenize(template: string, at: string): Token[] {
  const out: Token[] = [];
  let lit = '';
  let i = 0;
  const flush = () => { if (lit) { out.push({ lit }); lit = ''; } };

  while (i < template.length) {
    if (template.startsWith('{{{{', i)) { lit += '{{'; i += 4; continue; }
    if (template.startsWith('}}}}', i)) { lit += '}}'; i += 4; continue; }
    if (template.startsWith('{{', i)) {
      const end = template.indexOf('}}', i + 2);
      if (end < 0) {
        throw new DevkitError({
          code: 'REF_MALFORMED',
          message: `${at}: 닫히지 않은 참조 \`{{\``,
          hint: '리터럴 중괄호가 필요하면 {{{{ 로 표기하세요.',
          retryable: false,
        });
      }
      const name = template.slice(i + 2, end).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new DevkitError({
          code: 'REF_MALFORMED',
          message: `${at}: 참조 이름이 올바르지 않습니다 — \`${name}\``,
          hint: '참조는 {{KEY}} 형태이며 KEY는 영문/숫자/밑줄만 씁니다.',
          retryable: false,
        });
      }
      flush();
      out.push({ ref: name });
      i = end + 2;
      continue;
    }
    lit += template[i];
    i++;
  }
  flush();
  return out;
}

/** 템플릿이 직접 참조하는 key 목록. */
export function directRefs(template: string, at: string): string[] {
  return tokenize(template, at).flatMap((t) => ('ref' in t ? [t.ref] : []));
}

export type Index = Map<string, Item>;

/** 항목에 정의된 모든 env의 합집합. */
export function envsOf(index: Index): string[] {
  const s = new Set<string>();
  for (const it of index.values()) for (const e of Object.keys(it.value)) s.add(e);
  return [...s].sort();
}

/**
 * 기동/reload 시 1회 검증 (스펙 §4.7 "검증").
 * 순환 참조는 **실패**시키고, 없는 key 참조는 **경고**만 남긴다 — 후자는 조회 시점에
 * 명확한 에러가 나므로 나머지 항목까지 못 쓰게 만들 이유가 없다.
 */
export function validateRefs(index: Index): string[] {
  const warnings: string[] = [];
  for (const env of envsOf(index)) {
    for (const key of index.keys()) {
      detectCycle(key, env, index, [], new Set(), warnings);
    }
  }
  return [...new Set(warnings)];
}

function detectCycle(key: string, env: string, index: Index, path: string[], seen: Set<string>, warnings: string[]): void {
  if (path.includes(key)) {
    const cycle = [...path.slice(path.indexOf(key)), key].join(' → ');
    throw new DevkitError({
      code: 'CONFIG_REFERENCE_CYCLE',
      message: `순환 참조 (env=${env}): ${cycle}`,
      hint: '값 안의 {{...}} 참조가 자기 자신으로 돌아옵니다. 한쪽을 상수로 풀어주세요.',
      retryable: false,
    });
  }
  const marker = `${env}:${key}`;
  if (seen.has(marker)) return;
  seen.add(marker);

  const item = index.get(key);
  if (!item) return;
  const template = item.value[env];
  if (typeof template !== 'string') return;

  for (const ref of directRefs(template, `${key}.value.${env}`)) {
    if (!index.has(ref)) {
      warnings.push(`${key}.value.${env}가 정의되지 않은 key \`${ref}\`를 참조합니다`);
      continue;
    }
    detectCycle(ref, env, index, [...path, key], seen, warnings);
  }
}

export type Resolved = {
  key: string;
  env: string;
  /** 치환된 값. status가 ok가 아니면 null. */
  value: string | null;
  status: ItemStatus;
  /** 자신 + 모든 전이 참조 대상 중 가장 높은 민감도. 호출자는 반드시 이걸 봐야 한다. */
  visibility: Visibility;
  /** 이 값이 참조하는 key들 (전이 포함). 정책 판정에 쓴다. */
  refs: string[];
};

/**
 * 값 조회의 유일한 진입점. 참조를 치환하고 실효 visibility를 함께 계산한다.
 * `raw: true`면 템플릿 원본을 그대로 돌려주되, visibility 계산은 그대로 수행한다
 * (UI 편집 화면도 "이건 secret이다"를 알아야 하기 때문).
 */
export function resolveValue(key: string, env: string, index: Index, opts: { raw?: boolean } = {}): Resolved {
  const item = index.get(key);
  if (!item) {
    throw new DevkitError({
      code: 'KEY_NOT_FOUND',
      message: `정의되지 않은 key: ${key}`,
      hint: 'alias 검색으로 올바른 key를 먼저 찾으세요.',
      fixCommand: `dkc resolve "${key}"`,
      retryable: false,
    });
  }

  const refs = new Set<string>();
  const vis: Visibility[] = [item.visibility];

  if (item.locked) {
    return { key, env, value: null, status: 'locked', visibility: 'secret', refs: [] };
  }

  const template = item.value[env];
  if (template === undefined || template === null) {
    return {
      key,
      env,
      value: null,
      status: 'unset',
      visibility: item.visibility,
      refs: [],
    };
  }

  // raw 모드에서도 참조 그래프는 끝까지 따라가 민감도를 계산한다.
  walkRefs(key, env, index, refs, vis);
  const value = opts.raw ? template : substitute(key, env, index, 0);

  return {
    key,
    env,
    value,
    status: 'ok',
    visibility: vis.includes('secret') ? 'secret' : 'public',
    refs: [...refs].filter((r) => r !== key),
  };

  function walkRefs(k: string, e: string, idx: Index, acc: Set<string>, out: Visibility[], depth = 0): void {
    if (depth > MAX_DEPTH) return; // 깊이 초과는 substitute가 명확한 에러로 잡는다
    const it = idx.get(k);
    if (!it) return;
    out.push(it.visibility);
    if (it.locked) out.push('secret');
    const tpl = it.value[e];
    if (typeof tpl !== 'string') return;
    for (const r of directRefs(tpl, `${k}.value.${e}`)) {
      if (acc.has(r)) continue;
      acc.add(r);
      walkRefs(r, e, idx, acc, out, depth + 1);
    }
  }
}

function substitute(key: string, env: string, index: Index, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new DevkitError({
      code: 'REF_TOO_DEEP',
      message: `참조 깊이가 ${MAX_DEPTH}단계를 넘었습니다 (${key}.value.${env})`,
      hint: '중간 항목을 하나로 합쳐 참조 사슬을 줄이세요.',
      retryable: false,
    });
  }
  const item = index.get(key)!;
  const template = item.value[env];
  if (typeof template !== 'string') return '';

  let out = '';
  for (const tok of tokenize(template, `${key}.value.${env}`)) {
    if ('lit' in tok) { out += tok.lit; continue; }

    const ref = index.get(tok.ref);
    if (!ref) {
      throw new DevkitError({
        code: 'REF_UNRESOLVED',
        message: `${key}.value.${env}가 정의되지 않은 key \`${tok.ref}\`를 참조합니다`,
        hint: '참조 대상을 public.yaml 또는 secret.yaml에 추가하거나 오타를 고치세요.',
        retryable: false,
      });
    }
    if (ref.locked) {
      throw new DevkitError({
        code: 'SECRET_UNAVAILABLE',
        message: `${key}는 secret 항목 \`${tok.ref}\`를 참조하는데 복호화되지 않았습니다`,
        hint: 'age 개인키를 두고 데몬을 다시 기동하세요(축소 모드에서는 조회할 수 없습니다).',
        fixCommand: 'dkc daemon restart',
        retryable: false,
      });
    }
    const rv = ref.value[env];
    if (rv === undefined || rv === null) {
      throw new DevkitError({
        code: 'REF_UNSET',
        message: `${key}.value.${env}의 참조 \`${tok.ref}\`가 아직 미설정입니다`,
        hint: `UI에서 ${tok.ref}의 ${env} 값을 채우세요. 값이 없는 것이지 key가 틀린 게 아닙니다.`,
        fixCommand: 'dkc ui',
        retryable: false,
      });
    }
    out += substitute(tok.ref, env, index, depth + 1);
  }
  return out;
}

/**
 * env를 특정하지 않은 자리(alias 검색·목록)에서 쓰는 보수적 민감도.
 * 어느 한 env에서라도 secret이면 secret으로 본다 — 틀릴 거라면 안전한 쪽으로 틀린다.
 */
export function maxVisibility(key: string, index: Index): Visibility {
  const item = index.get(key);
  if (!item) return 'secret';
  if (item.visibility === 'secret' || item.locked) return 'secret';
  for (const env of Object.keys(item.value)) {
    const seen = new Set<string>([key]);
    const stack = [{ k: key, d: 0 }];
    while (stack.length) {
      const { k, d } = stack.pop()!;
      if (d > MAX_DEPTH) continue;
      const it = index.get(k);
      if (!it) continue;
      if (it.visibility === 'secret' || it.locked) return 'secret';
      const tpl = it.value[env];
      if (typeof tpl !== 'string') continue;
      for (const r of directRefs(tpl, `${k}.value.${env}`)) {
        if (seen.has(r)) continue;
        seen.add(r);
        stack.push({ k: r, d: d + 1 });
      }
    }
  }
  return 'public';
}
