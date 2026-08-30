/**
 * 데몬 수명주기 — 소켓 파일 잔존 처리와 축소 모드.
 *
 * 소켓 테스트가 있는 이유: stale 소켓을 무조건 unlink하는 구현은 평소엔 잘 돌다가
 * "두 번 띄웠을 때 첫 번째 데몬의 연결이 끊긴다"로만 드러난다. 그 사고를 여기서 잡는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start, probe } from '#config/daemon.ts';
import { call } from '#config/client.ts';
import { invalidatePolicy } from '#config/api.ts';
import { reset } from '#config/cache.ts';

let store = '';
let sock = '';

const PUBLIC = `items:
  - key: "A_TOPIC"
    resource_type: "kafka_topic"
    alias: ["가나다 토픽"]
    value:
      prod: "a.v1"
      dev: "a.v1.dev"
`;

before(() => {
  store = mkdtempSync(join(tmpdir(), 'dkc-daemon-'));
  mkdirSync(join(store, 'config'), { recursive: true });
  writeFileSync(join(store, 'config', 'public.yaml'), PUBLIC);
  // 짧은 경로를 쓴다 — UDS 경로는 macOS에서 104바이트 제한이 있다.
  sock = join(store, 'd.sock');
  process.env.DKC_STORE = store;
  process.env.DKC_SOCKET = sock;
  delete process.env.DKC_POLICY;
  invalidatePolicy();
  reset();
});

after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

test('secret.yaml이 없어도 public만으로 기동한다', async () => {
  const h = await start({ socket: sock, quiet: true });
  try {
    const r = await call('/status', { socket: sock });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.mode, 'full');
    assert.equal(r.body.data.items, 1);
    assert.match(r.body.data.warnings.join(' '), /secret\.yaml.*없습니다/);
  } finally {
    await h.close();
  }
});

test('소켓 파일 권한은 0600이고 정상 종료 시 지워진다', async () => {
  const h = await start({ socket: sock, quiet: true });
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  await h.close();
  assert.equal(existsSync(sock), false);
});

test('stale 소켓 파일은 정리하고 기동한다', async () => {
  // 프로세스가 SIGKILL로 죽어 소켓 파일만 남은 상황을 흉내낸다.
  writeFileSync(sock, '');
  assert.equal(await probe(sock), false);
  const h = await start({ socket: sock, quiet: true });
  try {
    assert.equal((await call('/health', { socket: sock })).status, 200);
  } finally {
    await h.close();
  }
});

test('살아있는 데몬의 소켓은 지우지 않고 중복 기동을 거부한다', async () => {
  const h = await start({ socket: sock, quiet: true });
  try {
    await assert.rejects(
      start({ socket: sock, quiet: true }),
      (e: any) => e.code === 'DAEMON_ALREADY_RUNNING',
    );
    // 핵심: 첫 데몬이 멀쩡히 살아 있어야 한다.
    assert.equal((await call('/health', { socket: sock })).status, 200);
  } finally {
    await h.close();
  }
});

test('기본 호출자는 agent다 — 헤더를 빠뜨리면 안전한 쪽으로 떨어진다', async () => {
  const h = await start({ socket: sock, quiet: true });
  try {
    // 정책 파일이 없으므로 에이전트는 전면 deny다.
    const asAgent = await call('/config/A_TOPIC', { socket: sock, caller: 'agent', agentId: 'x' });
    assert.equal(asAgent.status, 403);
    const asOwner = await call('/config/A_TOPIC', { socket: sock, caller: 'owner' });
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.data.value, 'a.v1.dev');
  } finally {
    await h.close();
  }
});

test('데몬이 없으면 클라이언트가 고칠 명령을 담은 구조화 에러를 준다', async () => {
  await assert.rejects(
    call('/health', { socket: join(store, 'nope.sock') }),
    (e: any) => e.code === 'DAEMON_UNAVAILABLE' && e.fixCommand === 'dkc daemon start',
  );
});
