/**
 * API Layer — 모든 surface(UI·MCP·CLI)가 통과하는 단일 지점 (스펙 §2.2).
 *
 * 전송(UDS/HTTP)과 분리해 순수 함수로 둔 이유: 정책·민감도 판정을 테스트에서
 * 소켓 없이 직접 호출해 검증할 수 있어야 하기 때문이다. 스펙 §6이 "구현·테스트 시
 * 최우선 검증 대상"으로 지목한 게 바로 이 판정 경로다.
 *
 * 로깅 규칙(스펙 §4.2): 이 파일은 key와 결과 코드만 로그로 넘긴다. 값은 절대 넘기지 않는다.
 */

import { DevkitError, toDevkitError } from '#core/errors.ts';
import { current, reload, replaceItem } from './cache.ts';
import { findAliasOwner, search } from './alias.ts';
import { metaVersion, type Item, type Visibility } from './model.ts';
import { maxVisibility, resolveValue } from './resolve.ts';
import { decideAliasWrite, decideValue, loadPolicy, type Caller, type Policy } from './policy.ts';
import { withFileLock, writeItems } from './store.ts';

/** env 파라미터 생략 시 기본값. prod 조회는 항상 명시적이어야 한다 (스펙 §4.2). */
export const DEFAULT_ENV = 'dev';

export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  caller: Caller;
};

export type ApiResponse = { status: number; body: unknown };

export type Logger = (line: { method: string; path: string; key?: string; status: number; code?: string }) => void;

let policyCache: Policy | null = null;

export function policy(): Policy {
  if (!policyCache) policyCache = loadPolicy();
  return policyCache;
}

export function invalidatePolicy(): void {
  policyCache = null;
}

export async function handle(req: ApiRequest, log: Logger = () => {}): Promise<ApiResponse> {
  try {
    const res = await route(req);
    log({ method: req.method, path: req.path, status: res.status });
    return res;
  } catch (err) {
    const e = toDevkitError(err);
    const status = statusOf(e.code);
    log({ method: req.method, path: req.path, status, code: e.code });
    return { status, body: { ok: false, error: e.toJSON() } };
  }
}

async function route(req: ApiRequest): Promise<ApiResponse> {
  const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method.toUpperCase();

  if (m === 'GET' && seg[0] === 'health') return ok({ status: 'up' });

  if (m === 'GET' && seg[0] === 'status') {
    const s = current();
    const p = policy();
    return ok({
      mode: s.mode,
      degradedReason: s.degradedReason,
      items: s.items.length,
      secretItems: s.items.filter((i) => i.visibility === 'secret').length,
      envs: [...new Set(s.items.flatMap((i) => Object.keys(i.value)))].sort(),
      warnings: s.warnings,
      policyLoaded: p.loaded,
      policyPath: p.path,
      loadedAt: new Date(s.loadedAt).toISOString(),
      defaultEnv: DEFAULT_ENV,
    });
  }

  if (m === 'POST' && seg[0] === 'reload') {
    invalidatePolicy();
    const s = await reload();
    return ok({ mode: s.mode, items: s.items.length, warnings: s.warnings });
  }

  if (m === 'GET' && seg[0] === 'items') return ok(listItems(req));

  if (m === 'POST' && seg[0] === 'items') return await createItem(req);

  if (m === 'GET' && seg[0] === 'config' && seg[1]) return getValue(req, seg.slice(1).join('/'));

  if (seg[0] === 'value' && seg[1] && m === 'PUT') return await putValue(req, seg.slice(1).join('/'));

  if (seg[0] === 'alias') {
    if (m === 'GET' && seg[1] === 'search') return aliasSearch(req);
    if (m === 'GET' && seg[1]) return aliasGet(seg[1]);
    if (m === 'POST' && seg[1]) return await aliasAdd(req, seg[1]);
    if (m === 'PUT' && seg[1]) return await aliasReplace(req, seg[1]);
    if (m === 'DELETE' && seg[1] && seg[2]) return await aliasDelete(req, seg[1], seg[2]);
  }

  throw new DevkitError({
    code: 'ROUTE_NOT_FOUND',
    message: `${m} ${req.path}`,
    hint: 'GET /status로 사용 가능한 상태를 먼저 확인하세요.',
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

function getValue(req: ApiRequest, key: string): ApiResponse {
  const env = req.query.get('env') ?? DEFAULT_ENV;
  const raw = req.query.get('raw') === 'true';
  const s = current();

  const resolved = resolveValue(key, env, s.index, { raw });
  const decision = decideValue(req.caller, key, resolved.visibility, policy());
  if (decision.effect === 'deny') {
    throw new DevkitError({
      code: 'POLICY_DENIED',
      message: `${key} 조회가 정책으로 거부되었습니다 — ${decision.reason}`,
      hint: `${policy().path}의 agents 항목에 이 key를 추가하거나, 값을 노출하지 않는 경로(env 주입)를 쓰세요.`,
      retryable: false,
    });
  }

  if (resolved.status === 'locked') {
    throw new DevkitError({
      code: 'SECRET_UNAVAILABLE',
      message: `${key}는 축소 모드에서 조회할 수 없습니다 — ${s.degradedReason ?? '복호화 불가'}`,
      hint: 'age 개인키를 두고 dkc reload를 실행하세요. 메타데이터 조회와 alias 검색은 계속 가능합니다.',
      fixCommand: 'dkc reload',
      retryable: true,
    });
  }

  const item = s.index.get(key)!;
  return ok({
    key,
    env,
    // status가 unset이면 value는 null이다. 404(정의 없음)와 다른 상태다 (스펙 §4.8).
    value: resolved.value,
    status: resolved.status,
    visibility: resolved.visibility,
    declaredVisibility: item.visibility,
    refs: resolved.refs,
    raw,
    resourceType: item.resourceType,
    desc: item.desc,
    ref: item.ref,
    alias: item.alias,
    version: metaVersion(item),
  });
}

function listItems(req: ApiRequest): unknown {
  const s = current();
  const env = req.query.get('env') ?? DEFAULT_ENV;
  const withValues = req.caller.kind === 'owner' && req.query.get('values') === 'true';

  return {
    env,
    mode: s.mode,
    items: s.items.map((it) => {
      const vis = maxVisibility(it.key, s.index);
      const base = {
        key: it.key,
        alias: it.alias,
        resourceType: it.resourceType,
        desc: it.desc,
        ref: it.ref,
        visibility: vis,
        declaredVisibility: it.visibility,
        locked: it.locked,
        envs: Object.keys(it.value),
        version: metaVersion(it),
      };
      if (!withValues) return base;
      // 소유자 화면(UI)만 값을 받는다. prod/dev를 나란히 볼 수 있어야 하므로 env별로 전부 싣는다.
      const values: Record<string, { value: string | null; status: string; error?: string }> = {};
      for (const e of Object.keys(it.value)) {
        try {
          const r = resolveValue(it.key, e, s.index);
          values[e] = { value: r.value, status: r.status };
        } catch (err) {
          values[e] = { value: null, status: 'error', error: toDevkitError(err).code };
        }
      }
      return { ...base, values, rawValues: it.value };
    }),
  };
}

function aliasSearch(req: ApiRequest): ApiResponse {
  const q = req.query.get('q') ?? '';
  const limit = Math.min(Number(req.query.get('limit') ?? 10) || 10, 50);
  // 값을 싣지 않으므로 정책 게이트가 없다. 이 분리가 2단계 조회 흐름의 전제다 (스펙 §4.3).
  return ok({ query: q, hits: search(q, current().index, limit) });
}

function aliasGet(key: string): ApiResponse {
  const it = requireItem(key);
  return ok({
    key,
    alias: it.alias,
    desc: it.desc,
    ref: it.ref,
    resourceType: it.resourceType,
    visibility: maxVisibility(key, current().index),
    version: metaVersion(it),
  });
}

// ---------------------------------------------------------------------------
// 편집
// ---------------------------------------------------------------------------

async function aliasAdd(req: ApiRequest, key: string): Promise<ApiResponse> {
  gate(decideAliasWrite(req.caller, 'add', policy()));
  const body = asObject(req.body);
  const alias = str(body.alias, 'alias');
  const it = requireItem(key);

  const owner = findAliasOwner(alias, current().index, key);
  if (owner) {
    throw new DevkitError({
      code: 'ALIAS_CONFLICT',
      message: `alias \`${alias}\`는 이미 ${owner}가 쓰고 있습니다`,
      hint: '같은 자연어가 두 리소스를 가리키면 에이전트가 틀린 값을 조회합니다. 다른 표현을 쓰세요.',
      retryable: false,
      details: { conflictKey: owner },
    });
  }
  if (it.alias.some((a) => a === alias)) return ok({ key, alias: it.alias, changed: false });

  const next = { ...it, alias: [...it.alias, alias] };
  await persist(next);
  return ok({ key, alias: next.alias, changed: true, version: metaVersion(next) });
}

async function aliasReplace(req: ApiRequest, key: string): Promise<ApiResponse> {
  gate(decideAliasWrite(req.caller, 'replace', policy()));
  const body = asObject(req.body);
  const it = requireItem(key);
  requireVersion(body, it);

  const next: Item = { ...it };
  if (body.alias !== undefined) {
    if (!Array.isArray(body.alias) || body.alias.some((a) => typeof a !== 'string')) {
      throw invalid('alias는 문자열 배열이어야 합니다');
    }
    for (const a of body.alias as string[]) {
      const owner = findAliasOwner(a, current().index, key);
      if (owner) {
        throw new DevkitError({
          code: 'ALIAS_CONFLICT',
          message: `alias \`${a}\`는 이미 ${owner}가 쓰고 있습니다`,
          retryable: false,
          details: { conflictKey: owner },
        });
      }
    }
    next.alias = body.alias as string[];
  }
  if (body.desc !== undefined) next.desc = nullableStr(body.desc, 'desc');
  if (body.ref !== undefined) next.ref = nullableStr(body.ref, 'ref');
  if (body.resource_type !== undefined) next.resourceType = nullableStr(body.resource_type, 'resource_type');

  // key와 value는 이 경로로 절대 바뀌지 않는다 (스펙 §4.5). 요청에 실려와도 무시가 아니라 거부한다.
  if ('key' in body || 'value' in body) {
    throw invalid('이 API로는 key와 value를 수정할 수 없습니다. 값 변경은 PUT /value/{key}(소유자 전용)를 쓰세요.');
  }

  await persist(next);
  return ok({ key, alias: next.alias, desc: next.desc, ref: next.ref, resourceType: next.resourceType, version: metaVersion(next) });
}

async function aliasDelete(req: ApiRequest, key: string, alias: string): Promise<ApiResponse> {
  gate(decideAliasWrite(req.caller, 'delete', policy()));
  const it = requireItem(key);
  const next = { ...it, alias: it.alias.filter((a) => a !== alias) };
  if (next.alias.length === it.alias.length) {
    throw new DevkitError({ code: 'ALIAS_NOT_FOUND', message: `${key}에 alias \`${alias}\`가 없습니다`, retryable: false });
  }
  await persist(next);
  return ok({ key, alias: next.alias, version: metaVersion(next) });
}

/** 값 변경은 소유자(UI/CLI) 전용이다. 에이전트에게는 이 경로를 열지 않는다. */
async function putValue(req: ApiRequest, key: string): Promise<ApiResponse> {
  requireOwner(req, '값 변경');
  const body = asObject(req.body);
  const env = typeof body.env === 'string' ? body.env : DEFAULT_ENV;
  const it = requireItem(key);
  requireVersion(body, it);

  if (body.value !== null && typeof body.value !== 'string') {
    throw invalid('value는 문자열이거나 null(미설정)이어야 합니다');
  }
  const next: Item = { ...it, value: { ...it.value, [env]: body.value as string | null } };
  await persist(next);
  return ok({ key, env, status: next.value[env] === null ? 'unset' : 'ok', version: metaVersion(next) });
}

async function createItem(req: ApiRequest): Promise<ApiResponse> {
  requireOwner(req, '항목 추가');
  const body = asObject(req.body);
  const key = str(body.key, 'key');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw invalid('key는 영문/숫자/밑줄만 쓰고 숫자로 시작할 수 없습니다 (참조 문법 {{KEY}}와 맞춥니다)');
  }
  if (current().index.has(key)) {
    throw new DevkitError({ code: 'KEY_EXISTS', message: `key ${key}는 이미 있습니다`, retryable: false });
  }
  const visibility: Visibility = body.visibility === 'secret' ? 'secret' : 'public';
  const item: Item = {
    key,
    resourceType: nullableStr(body.resource_type ?? null, 'resource_type'),
    alias: Array.isArray(body.alias) ? (body.alias as string[]).filter((a) => typeof a === 'string') : [],
    value: { prod: null, dev: null },
    desc: nullableStr(body.desc ?? null, 'desc'),
    ref: nullableStr(body.ref ?? null, 'ref'),
    visibility,
    locked: false,
  };
  for (const a of item.alias) {
    const owner = findAliasOwner(a, current().index);
    if (owner) throw new DevkitError({ code: 'ALIAS_CONFLICT', message: `alias \`${a}\`는 이미 ${owner}가 씁니다`, retryable: false, details: { conflictKey: owner } });
  }

  // 축소 모드에서 secret 파일을 다시 쓰면 잠긴(값 없는) 항목들이 그대로 저장되어 값이 날아간다.
  if (visibility === 'secret' && current().mode === 'reduced') {
    throw new DevkitError({
      code: 'SECRET_UNAVAILABLE',
      message: '축소 모드에서는 secret 항목을 추가할 수 없습니다 — 기존 값이 유실됩니다',
      hint: 'age 개인키를 두고 dkc reload를 실행한 뒤 다시 시도하세요.',
      fixCommand: 'dkc reload',
      retryable: true,
    });
  }

  await withFileLock(visibility, async () => {
    const s = current();
    await writeItems(visibility, [...s.items.filter((i) => i.visibility === visibility), item]);
  });
  // 새 key가 생기면 인덱스를 다시 세워야 한다. 항목 추가는 드문 연산이라 전체 재적재를 감수한다.
  await reload();
  return { status: 201, body: { ok: true, data: { key, visibility } } };
}

/**
 * 파일 반영 + 캐시 갱신. 순서가 중요하다: 파일이 먼저다.
 * 캐시가 파일보다 앞서가면 데몬 재기동 후 값이 되돌아가 "고쳤는데 왜 그대로지"가 된다.
 */
async function persist(next: Item): Promise<void> {
  const s = current();
  if (next.visibility === 'secret' && s.mode === 'reduced') {
    throw new DevkitError({
      code: 'SECRET_UNAVAILABLE',
      message: `축소 모드에서는 secret 항목(${next.key})을 수정할 수 없습니다`,
      hint: 'alias는 평문이지만 sops가 파일 MAC을 다시 계산해야 하므로 개인키가 필요합니다 (스펙 §4.5). 개인키를 두고 dkc reload를 실행하세요.',
      fixCommand: 'dkc reload',
      retryable: true,
    });
  }
  await withFileLock(next.visibility, async () => {
    const items = current().items.map((it) => (it.key === next.key ? next : it));
    await writeItems(next.visibility, items.filter((i) => i.visibility === next.visibility));
    replaceItem(next);
  });
}

// ---------------------------------------------------------------------------
// 보조
// ---------------------------------------------------------------------------

function ok(data: unknown): ApiResponse {
  return { status: 200, body: { ok: true, data } };
}

function requireItem(key: string): Item {
  const it = current().index.get(key);
  if (!it) {
    throw new DevkitError({
      code: 'KEY_NOT_FOUND',
      message: `정의되지 않은 key: ${key}`,
      hint: 'alias 검색으로 올바른 key를 먼저 찾으세요. "값이 없음"(status: unset)과는 다른 상태입니다.',
      fixCommand: `dkc resolve "${key}"`,
      retryable: false,
    });
  }
  return it;
}

function requireOwner(req: ApiRequest, what: string): void {
  if (req.caller.kind !== 'owner') {
    throw new DevkitError({
      code: 'POLICY_DENIED',
      message: `${what}은 소유자(UI/CLI)만 할 수 있습니다`,
      hint: '에이전트에게는 조회와 alias 추가까지만 열려 있습니다 (스펙 §4.5).',
      retryable: false,
    });
  }
}

/** 낙관적 잠금: 조회 시 받은 version이 그대로여야 쓴다 (스펙 §4.5). */
function requireVersion(body: Record<string, unknown>, it: Item): void {
  const v = body.version;
  if (typeof v !== 'string') {
    throw invalid('version이 필요합니다. GET으로 현재 version을 받아 그대로 실어 보내세요.');
  }
  if (v !== metaVersion(it)) {
    throw new DevkitError({
      code: 'VERSION_CONFLICT',
      message: `${it.key}가 조회 이후에 변경되었습니다`,
      hint: '다시 조회해 최신 상태를 확인한 뒤 편집하세요. 마지막 쓰기가 조용히 덮어쓰는 걸 막습니다.',
      retryable: true,
      details: { current: metaVersion(it) },
    });
  }
}

function gate(d: { effect: 'allow' | 'deny'; reason: string }): void {
  if (d.effect === 'deny') {
    throw new DevkitError({ code: 'POLICY_DENIED', message: d.reason, retryable: false });
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('요청 본문은 JSON 객체여야 합니다');
  return body as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`${field}는 비어있지 않은 문자열이어야 합니다`);
  return v;
}

function nullableStr(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw invalid(`${field}는 문자열이거나 null이어야 합니다`);
  return v;
}

function invalid(message: string): DevkitError {
  return new DevkitError({ code: 'INPUT_INVALID', message, retryable: false });
}

function statusOf(code: string): number {
  switch (code) {
    case 'KEY_NOT_FOUND':
    case 'ALIAS_NOT_FOUND':
    case 'ROUTE_NOT_FOUND':
      return 404;
    case 'POLICY_DENIED':
      return 403;
    case 'ALIAS_CONFLICT':
    case 'VERSION_CONFLICT':
    case 'KEY_EXISTS':
    case 'STORE_LOCK_BUSY':
      return 409;
    case 'INPUT_INVALID':
    case 'QUERY_EMPTY':
    case 'REF_MALFORMED':
      return 400;
    case 'REF_UNRESOLVED':
    case 'REF_UNSET':
    case 'REF_TOO_DEEP':
      return 422;
    case 'SECRET_UNAVAILABLE':
    case 'SOPS_NOT_INSTALLED':
      return 503;
    default:
      return 500;
  }
}
