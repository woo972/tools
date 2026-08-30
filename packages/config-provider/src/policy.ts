/**
 * Policy Guard — 에이전트별 화이트리스트 (스펙 §4.3).
 *
 * 판정 순서가 중요하다. **민감도를 먼저 보고 key를 나중에 본다.**
 * 반대로 하면 `allow: ["*"]`를 한번 켠 순간 참조를 통해 secret이 딸려온 항목까지
 * 전부 열린다(스펙 §6이 지목한 취약점). 그래서 실효 visibility가 secret이면
 * `allow_secret`을 따로 켜지 않는 한 key 매치와 무관하게 거부한다.
 *
 * 정책 파일이 없으면 "에이전트에게 아무것도 안 준다"가 기본값이다. 설정을 깜빡한 상태가
 * 곧 안전한 상태가 되게 한다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { DevkitError } from '#core/errors.ts';
import { parse, type YamlNode } from './yaml.ts';
import { policyPath } from './paths.ts';
import type { Visibility } from './model.ts';

export type CallerKind = 'owner' | 'agent';

export type Caller = {
  kind: CallerKind;
  /** MCP `_meta.agentId` 또는 DKC_AGENT_ID. owner면 'owner'. */
  agentId: string;
};

export type AgentRule = {
  id: string;
  allow: string[];
  allowSecret: boolean;
  aliasWrite: boolean;
};

export type Policy = {
  rules: AgentRule[];
  /** 정책 파일이 실제로 존재했는지. doctor가 "기본 deny로 도는 중"임을 알려주는 데 쓴다. */
  loaded: boolean;
  path: string;
};

const EMPTY_RULE: AgentRule = { id: '*', allow: [], allowSecret: false, aliasWrite: false };

export function loadPolicy(): Policy {
  const p = policyPath();
  if (!existsSync(p)) return { rules: [], loaded: false, path: p };

  let doc: YamlNode;
  try {
    doc = parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new DevkitError({
      code: 'POLICY_PARSE_FAILED',
      message: `정책 파일 파싱 실패 — ${(err as Error).message}`,
      hint: `${p}를 확인하세요. 파싱에 실패하면 기본 deny로 떨어지는 대신 명시적으로 실패시킵니다 — 조용히 문이 닫히면 원인을 못 찾습니다.`,
      retryable: false,
    });
  }
  const agents = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as any).agents : null;
  if (!Array.isArray(agents)) return { rules: [], loaded: true, path: p };

  const rules = agents.map((a: any, i: number) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new DevkitError({ code: 'POLICY_PARSE_FAILED', message: `agents[${i}]는 맵이어야 합니다`, retryable: false });
    }
    return {
      id: typeof a.id === 'string' ? a.id : '*',
      allow: Array.isArray(a.allow) ? a.allow.filter((x: unknown) => typeof x === 'string') : [],
      allowSecret: a.allow_secret === true,
      aliasWrite: a.alias_write === true,
    };
  });
  return { rules, loaded: true, path: p };
}

/**
 * 해당 에이전트에 적용되는 유효 규칙.
 * `*` 규칙은 모두에게 적용되는 기준선이고, id가 정확히 일치하는 규칙이 그 위에 더해진다
 * (allow는 합집합, 불린은 OR).
 */
export function ruleFor(agentId: string, policy: Policy): AgentRule {
  const applicable = policy.rules.filter((r) => r.id === '*' || r.id === agentId);
  if (applicable.length === 0) return { ...EMPTY_RULE, id: agentId };
  return applicable.reduce<AgentRule>(
    (acc, r) => ({
      id: agentId,
      allow: [...acc.allow, ...r.allow],
      allowSecret: acc.allowSecret || r.allowSecret,
      aliasWrite: acc.aliasWrite || r.aliasWrite,
    }),
    { ...EMPTY_RULE, id: agentId },
  );
}

export type Decision = { effect: 'allow' | 'deny'; reason: string };

/** 값 조회 판정. `visibility`는 반드시 참조까지 반영한 **실효값**을 넘겨야 한다. */
export function decideValue(caller: Caller, key: string, visibility: Visibility, policy: Policy): Decision {
  // 소유자(UI/CLI)는 화이트리스트를 거치지 않는다. UI는 본인이 원본 평문을 확인하는
  // 유일한 창구이고(스펙 §4.4), 여기에 정책을 걸면 요구사항 자체가 무너진다.
  if (caller.kind === 'owner') return { effect: 'allow', reason: 'owner' };

  const rule = ruleFor(caller.agentId, policy);

  if (visibility === 'secret' && !rule.allowSecret) {
    return {
      effect: 'deny',
      reason: `실효 visibility가 secret입니다. ${caller.agentId}에 allow_secret이 켜져 있지 않습니다`,
    };
  }
  if (rule.allow.some((pat) => globMatch(pat, key))) {
    return { effect: 'allow', reason: `${caller.agentId} 화이트리스트 매치` };
  }
  return {
    effect: 'deny',
    reason: policy.loaded
      ? `${caller.agentId}의 allow 목록에 ${key}가 없습니다 (기본 정책 deny)`
      : `정책 파일이 없어 기본 정책 deny가 적용됩니다 (${policy.path})`,
  };
}

/**
 * alias 편집 판정.
 * 에이전트에게는 추가(POST)까지만 허용하고 전체 교체(PUT)·삭제(DELETE)는 사람 몫이다
 * (스펙 §4.5: 에이전트가 용어집을 통째로 날리는 사고 방지).
 */
export function decideAliasWrite(caller: Caller, op: 'add' | 'replace' | 'delete', policy: Policy): Decision {
  if (caller.kind === 'owner') return { effect: 'allow', reason: 'owner' };
  if (op !== 'add') {
    return { effect: 'deny', reason: `에이전트는 alias ${op}를 할 수 없습니다. 추가(add)만 허용됩니다` };
  }
  const rule = ruleFor(caller.agentId, policy);
  return rule.aliasWrite
    ? { effect: 'allow', reason: `${caller.agentId} alias_write 허용` }
    : { effect: 'deny', reason: `${caller.agentId}에 alias_write가 켜져 있지 않습니다` };
}

/** `*`만 지원하는 글로브. 정규식을 그대로 받으면 정책 파일이 읽기 어려워진다. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
