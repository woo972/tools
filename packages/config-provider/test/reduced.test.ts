/**
 * 축소 모드 (스펙 §4.2 / §4.5).
 *
 * age 개인키가 없을 때 전체 기동을 실패시키는 대신 public만으로 도는 게 맞다는 판단이
 * 실제로 성립하는지 본다. 핵심은 "secret 항목의 alias 검색은 계속 되고, 값 조회만
 * 명확히 실패한다"는 것 — 암호화 후에도 메타데이터가 평문으로 남기 때문에 가능하다(§5.3).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

before(async () => {
  if (SKIP) return;
  store = mkdtempSync(join(tmpdir(), 'dkc-reduced-'));
  mkdirSync(join(store, 'config'), { recursive: true });

  const keyFile = join(store, 'keys.txt');
  spawnSync('age-keygen', ['-o', keyFile], { stdio: 'pipe' });
  const recipient = readFileSync(keyFile, 'utf8').match(/public key: (age1[0-9a-z]+)/)![1];
  writeFileSync(join(store, '.sops.yaml'), `creation_rules:\n  - path_regex: config/secret\\.yaml$\n    encrypted_regex: '^value$'\n    age: ${recipient}\n`);

  writeFileSync(join(store, 'config', 'public.yaml'), `items:\n  - key: "PUB"\n    alias: ["공개값"]\n    value:\n      dev: "ok"\n`);

  const secretFile = join(store, 'config', 'secret.yaml');
  writeFileSync(secretFile, `items:\n  - key: "DB_PASSWORD"\n    resource_type: "password"\n    alias: ["주문 DB 비밀번호"]\n    value:\n      prod: "prod-real-password"\n      dev: "dev-password"\n    desc: "메인 주문 DB 비밀번호"\n`);
  const enc = spawnSync('sops', ['--config', join(store, '.sops.yaml'), 'encrypt', '--filename-override', secretFile, '--input-type', 'yaml', '--output-type', 'yaml', secretFile], { encoding: 'utf8' });
  assert.equal(enc.status, 0, enc.stderr);
  writeFileSync(secretFile, enc.stdout);

  process.env.DKC_STORE = store;
  process.env.DKC_POLICY = join(store, 'nope.yaml');
  // 개인키를 없는 경로로 돌려 복호화를 실패시킨다.
  process.env.SOPS_AGE_KEY_FILE = join(store, 'missing-key.txt');
  invalidatePolicy();
  reset();
  await reload();
});

after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

function req(method: string, path: string, opts: { query?: string; body?: unknown } = {}) {
  return handle({ method, path, query: new URLSearchParams(opts.query ?? ''), body: opts.body ?? null, caller: owner });
}

test('개인키가 없어도 기동한다 — 전체 실패보다 부분 가용이 유용하다', { skip: SKIP }, () => {
  const s = current();
  assert.equal(s.mode, 'reduced');
  assert.equal(s.items.length, 2);
  assert.match(s.warnings.join(' '), /복호화하지 못했습니다/);
});

test('public 항목은 정상 조회된다', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/PUB');
  assert.equal(r.status, 200);
  assert.equal((r.body as any).data.value, 'ok');
});

test('secret 항목의 alias 검색은 계속 동작한다 — 메타데이터가 평문이기 때문', { skip: SKIP }, async () => {
  const r = await req('GET', '/alias/search', { query: 'q=주문 DB 비밀번호' });
  const hits = (r.body as any).data.hits;
  assert.equal(hits[0].key, 'DB_PASSWORD');
  assert.equal(hits[0].desc, '메인 주문 DB 비밀번호');
});

test('secret 값 조회는 503으로 명확히 실패하고 고칠 방법을 알려준다', { skip: SKIP }, async () => {
  const r = await req('GET', '/config/DB_PASSWORD');
  assert.equal(r.status, 503);
  assert.equal((r.body as any).error.code, 'SECRET_UNAVAILABLE');
  assert.equal((r.body as any).error.fixCommand, 'dkc reload');
});

test('암호문이 값으로 새어나가지 않는다', { skip: SKIP }, async () => {
  const r = await req('GET', '/items', { query: 'values=true' });
  const text = JSON.stringify(r.body);
  assert.equal(text.includes('ENC[AES256_GCM'), false);
  assert.equal(text.includes('prod-real-password'), false);
});

test('축소 모드에서 secret 항목의 alias 편집은 거부된다 — sops MAC 재계산에 개인키가 필요하다', { skip: SKIP }, async () => {
  const r = await req('POST', '/alias/DB_PASSWORD', { body: { alias: '디비 비번' } });
  assert.equal(r.status, 503);
  assert.equal((r.body as any).error.code, 'SECRET_UNAVAILABLE');
});

test('축소 모드에서도 public 항목의 alias 편집은 된다 — 평문 파일이라 키가 필요 없다', { skip: SKIP }, async () => {
  const r = await req('POST', '/alias/PUB', { body: { alias: '퍼블릭' } });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as any).data.alias, ['공개값', '퍼블릭']);
});
