/**
 * API 계층 통합 테스트 — 실제 sops+age 암호화를 거친다.
 *
 * 목킹하지 않는 이유: 이 서비스에서 가장 잘 깨지는 곳이 "암호화 왕복 후에도 구조가
 * 유지되는가"와 "실효 민감도가 정책까지 전달되는가"인데, 둘 다 sops를 흉내내면 검증되지 않는다.
 * sops나 age가 없는 환경에서는 통째로 skip한다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handle, invalidatePolicy } from '#config/api.ts';
import { reload, reset, current } from '#config/cache.ts';
import type { Caller } from '#config/policy.ts';

const has = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = !has('sops') || !has('age') ? 'sops 또는 age가 설치되어 있지 않습니다' : false;

let store = '';
const owner: Caller = { kind: 'owner', agentId: 'owner' };
const claude: Caller = { kind: 'agent', agentId: 'claude-code' };
const trusted: Caller = { kind: 'agent', agentId: 'trusted' };

const PUBLIC = `items:
  - key: "ORDER_SERVICE_HOST"
    resource_type: "endpoint"
    alias: ["주문 서비스"]
    value:
      prod: "order-svc.internal"
      dev: "order-svc.dev.internal"
    desc: "주문 서비스 호스트"
  - key: "INBOUND_INSTRUCTION_TOPIC"
    resource_type: "kafka_topic"
    alias: ["입고지시"]
    value:
      prod: "moms.inbound.v1"
      dev: "moms.inbound.v1.dev"
  - key: "ORDER_DB_URL"
    alias: ["주문 DB 접속 문자열"]
    value:
      prod: "postgres://o:{{DB_PASSWORD}}@{{ORDER_SERVICE_HOST}}:5432/orders"
      dev: "postgres://o:{{DB_PASSWORD}}@{{ORDER_SERVICE_HOST}}:5432/orders"
  - key: "NEW_SERVICE_ENDPOINT"
    alias: ["신규 서비스"]
    value:
      prod: null
      dev: "new-svc.dev.internal"
`;

const SECRET = `items:
  - key: "DB_PASSWORD"
    resource_type: "password"
    alias: ["주문 DB 비밀번호"]
    value:
      prod: "prod-real-password"
      dev: "dev-password"
    desc: "메인 주문 DB 비밀번호"
`;

const POLICY = `agents:
  - id: "*"
    allow: []
  - id: "claude-code"
    allow: ["*_TOPIC", "ORDER_SERVICE_HOST", "ORDER_DB_URL", "NEW_SERVICE_ENDPOINT"]
    alias_write: true
  - id: "trusted"
    allow: ["*"]
    allow_secret: true
`;

before(async () => {
  if (SKIP) return;
  store = mkdtempSync(join(tmpdir(), 'dkc-test-'));
  mkdirSync(join(store, 'config'), { recursive: true });

  const keyFile = join(store, 'keys.txt');
  spawnSync('age-keygen', ['-o', keyFile], { encoding: 'utf8', stdio: 'pipe' });
  const recipient = readFileSync(keyFile, 'utf8').match(/public key: (age1[0-9a-z]+)/)![1];

  writeFileSync(join(store, '.sops.yaml'), `creation_rules:\n  - path_regex: config/secret\\.yaml$\n    encrypted_regex: '^value$'\n    age: ${recipient}\n`);
  writeFileSync(join(store, 'config', 'public.yaml'), PUBLIC);
  writeFileSync(join(store, 'policy.yaml'), POLICY);

  const secretFile = join(store, 'config', 'secret.yaml');
  writeFileSync(secretFile, SECRET);
  const enc = spawnSync('sops', ['--config', join(store, '.sops.yaml'), 'encrypt', '--filename-override', secretFile, '--input-type', 'yaml', '--output-type', 'yaml', secretFile], { encoding: 'utf8' });
  assert.equal(enc.status, 0, enc.stderr);
  writeFileSync(secretFile, enc.stdout);

  process.env.DKC_STORE = store;
  process.env.DKC_POLICY = join(store, 'policy.yaml');
  process.env.SOPS_AGE_KEY_FILE = keyFile;
  invalidatePolicy();
  reset();
  await reload();
});

after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

function req(method: string, path: string, opts: { query?: string; body?: unknown; caller?: Caller } = {}) {
  return handle({
    method,
    path,
    query: new URLSearchParams(opts.query ?? ''),
    body: opts.body ?? null,
    caller: opts.caller ?? owner,
  });
}

test('sops 왕복 후에도 평문 메타데이터는 그대로고 값만 암호화된다', { skip: SKIP }, () => {
  const raw = readFileSync(join(store, 'config', 'secret.yaml'), 'utf8');
  assert.match(raw, /DB_PASSWORD/);          // key는 평문
  assert.match(raw, /주문 DB 비밀번호/);        // alias도 평문
  assert.match(raw, /ENC\[AES256_GCM/);      // 값은 암호문
  assert.equal(raw.includes('prod-real-password'), false);
});

test('env를 생략하면 dev다 — prod는 항상 명시적이어야 한다', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/ORDER_SERVICE_HOST');
  assert.equal((r.body as any).data.env, 'dev');
  assert.equal((r.body as any).data.value, 'order-svc.dev.internal');
});

test('정의 없는 key는 404, 값이 없는 key는 200 + status unset', { skip: SKIP }, async () => {
  const missing = await req('GET', '/config/NOPE');
  assert.equal(missing.status, 404);
  assert.equal((missing.body as any).error.code, 'KEY_NOT_FOUND');

  const unset = await req('GET', '/config/NEW_SERVICE_ENDPOINT', { query: 'env=prod' });
  assert.equal(unset.status, 200);
  assert.equal((unset.body as any).data.status, 'unset');
  assert.equal((unset.body as any).data.value, null);
});

test('secret을 참조하는 public 항목은 에이전트에게 거부된다 (스펙 §6 최우선 검증)', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/ORDER_DB_URL', { caller: claude });
  assert.equal(r.status, 403);
  assert.equal((r.body as any).error.code, 'POLICY_DENIED');
  // 거부 응답에 값의 흔적이 없어야 한다.
  assert.equal(JSON.stringify(r.body).includes('prod-real-password'), false);
});

test('같은 항목이 소유자에게는 치환된 원본 값으로 나온다', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/ORDER_DB_URL', { query: 'env=prod' });
  assert.equal((r.body as any).data.value, 'postgres://o:prod-real-password@order-svc.internal:5432/orders');
  assert.equal((r.body as any).data.visibility, 'secret');
  assert.equal((r.body as any).data.declaredVisibility, 'public');
});

test('allow_secret을 켠 에이전트만 참조로 secret이 섞인 값을 받는다', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/ORDER_DB_URL', { caller: trusted });
  assert.equal(r.status, 200);
  assert.match((r.body as any).data.value, /dev-password/);
});

test('alias 검색은 정책 없이도 되지만 값을 싣지 않는다', { skip: SKIP }, async () => {
  const r = await req('GET', '/alias/search', { query: 'q=주문 DB 비밀번호', caller: claude });
  assert.equal(r.status, 200);
  const hits = (r.body as any).data.hits;
  assert.equal(hits[0].key, 'DB_PASSWORD');
  assert.equal(hits[0].visibility, 'secret');
  assert.equal(JSON.stringify(r.body).includes('dev-password'), false);
});

test('alias API로는 key와 value를 바꿀 수 없다', { skip: SKIP }, async () => {
  const cur = (await req('GET', '/alias/ORDER_SERVICE_HOST')).body as any;
  const r = await req('PUT', '/alias/ORDER_SERVICE_HOST', {
    body: { version: cur.data.version, value: { dev: 'hacked' } },
  });
  assert.equal(r.status, 400);
  assert.equal((await req('GET', '/config/ORDER_SERVICE_HOST')).body.data.value, 'order-svc.dev.internal');
});

test('없는 key에 대한 alias 편집은 404다 — 이 API로 항목을 만들 수 없다', { skip: SKIP }, async () => {
  const r = await req('POST', '/alias/NOT_THERE', { body: { alias: 'x' } });
  assert.equal(r.status, 404);
});

test('중복 alias는 409로 거부하고 충돌 대상 key를 알려준다', { skip: SKIP }, async () => {
  const r = await req('POST', '/alias/ORDER_SERVICE_HOST', { body: { alias: '입고 지시' } });
  assert.equal(r.status, 409);
  assert.equal((r.body as any).error.code, 'ALIAS_CONFLICT');
  assert.equal((r.body as any).error.details.conflictKey, 'INBOUND_INSTRUCTION_TOPIC');
});

test('낙관적 잠금: 옛 version으로는 쓸 수 없다', { skip: SKIP }, async () => {
  const stale = ((await req('GET', '/alias/ORDER_SERVICE_HOST')).body as any).data.version;
  await req('POST', '/alias/ORDER_SERVICE_HOST', { body: { alias: '주문서비스호스트' } });
  const r = await req('PUT', '/alias/ORDER_SERVICE_HOST', { body: { version: stale, desc: 'x' } });
  assert.equal(r.status, 409);
  assert.equal((r.body as any).error.code, 'VERSION_CONFLICT');
});

test('에이전트는 alias 추가만 가능하고 교체·삭제·값 변경은 막힌다', { skip: SKIP }, async () => {
  const add = await req('POST', '/alias/INBOUND_INSTRUCTION_TOPIC', { body: { alias: '입고 이벤트' }, caller: claude });
  assert.equal(add.status, 200);

  const cur = ((await req('GET', '/alias/INBOUND_INSTRUCTION_TOPIC')).body as any).data;
  assert.equal((await req('PUT', '/alias/INBOUND_INSTRUCTION_TOPIC', { body: { version: cur.version, alias: [] }, caller: claude })).status, 403);
  assert.equal((await req('DELETE', '/alias/INBOUND_INSTRUCTION_TOPIC/입고지시', { caller: claude })).status, 403);
  assert.equal((await req('PUT', '/value/INBOUND_INSTRUCTION_TOPIC', { body: { env: 'dev', value: 'x', version: cur.version }, caller: claude })).status, 403);
});

test('secret 항목의 alias 편집은 파일을 다시 암호화한 채로 저장한다', { skip: SKIP }, async () => {
  const r = await req('POST', '/alias/DB_PASSWORD', { body: { alias: '디비 비번' } });
  assert.equal(r.status, 200);
  const raw = readFileSync(join(store, 'config', 'secret.yaml'), 'utf8');
  assert.match(raw, /디비 비번/);            // alias는 평문으로 남는다
  assert.match(raw, /ENC\[AES256_GCM/);
  assert.equal(raw.includes('prod-real-password'), false);

  // 값도 그대로 살아 있어야 한다 — 재암호화가 값을 날리지 않았는지 확인.
  assert.equal(((await req('GET', '/config/DB_PASSWORD', { query: 'env=prod' })).body as any).data.value, 'prod-real-password');
});

test('값 변경은 파일에 반영되고 캐시도 함께 갱신된다', { skip: SKIP }, async () => {
  const cur = ((await req('GET', '/alias/NEW_SERVICE_ENDPOINT')).body as any).data;
  await req('PUT', '/value/NEW_SERVICE_ENDPOINT', { body: { env: 'prod', value: 'new-svc.internal', version: cur.version } });
  assert.equal(((await req('GET', '/config/NEW_SERVICE_ENDPOINT', { query: 'env=prod' })).body as any).data.value, 'new-svc.internal');
  assert.match(readFileSync(join(store, 'config', 'public.yaml'), 'utf8'), /new-svc\.internal/);
});

test('reload가 실패하면 기존 캐시를 그대로 유지한다', { skip: SKIP }, async () => {
  const before = current().items.length;
  const pubFile = join(store, 'config', 'public.yaml');
  const backup = readFileSync(pubFile, 'utf8');
  writeFileSync(pubFile, 'items:\n  - key: "ORDER_SERVICE_HOST"\n  - key: "ORDER_SERVICE_HOST"\n');

  await assert.rejects(reload(), (e: any) => e.code === 'CONFIG_DUPLICATE_KEY');
  assert.equal(current().items.length, before);
  assert.equal(((await req('GET', '/config/ORDER_SERVICE_HOST')).body as any).data.value, 'order-svc.dev.internal');

  writeFileSync(pubFile, backup);
  await reload();
});
