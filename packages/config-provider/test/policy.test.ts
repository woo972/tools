import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAliasWrite, decideValue, globMatch, ruleFor, type Policy } from '#config/policy.ts';

const owner = { kind: 'owner', agentId: 'owner' } as const;
const agent = (id: string) => ({ kind: 'agent', agentId: id } as const);

const policy: Policy = {
  loaded: true,
  path: '/tmp/policy.yaml',
  rules: [
    { id: '*', allow: [], allowSecret: false, aliasWrite: false },
    { id: 'claude-code', allow: ['*_TOPIC', 'ORDER_SERVICE_HOST'], allowSecret: false, aliasWrite: true },
    { id: 'trusted', allow: ['DB_PASSWORD'], allowSecret: true, aliasWrite: false },
  ],
};

const empty: Policy = { loaded: false, path: '/tmp/none.yaml', rules: [] };

test('정책 파일이 없으면 에이전트는 아무것도 못 본다', () => {
  assert.equal(decideValue(agent('x'), 'ANY_KEY', 'public', empty).effect, 'deny');
});

test('소유자는 화이트리스트를 거치지 않는다 — UI가 원본 평문을 보는 유일한 창구다', () => {
  assert.equal(decideValue(owner, 'DB_PASSWORD', 'secret', empty).effect, 'allow');
});

test('화이트리스트에 있는 public key는 허용된다', () => {
  assert.equal(decideValue(agent('claude-code'), 'INBOUND_TOPIC', 'public', policy).effect, 'allow');
  assert.equal(decideValue(agent('claude-code'), 'OTHER_KEY', 'public', policy).effect, 'deny');
});

test('민감도를 key보다 먼저 본다 — allow에 있어도 secret이면 거부된다', () => {
  // 참조를 통해 secret이 섞여 들어온 항목(예: ORDER_DB_URL → DB_PASSWORD)이 정확히 이 경우다.
  const d = decideValue(agent('claude-code'), 'ORDER_SERVICE_HOST', 'secret', policy);
  assert.equal(d.effect, 'deny');
  assert.match(d.reason, /allow_secret/);
});

test('allow_secret을 명시적으로 켠 에이전트만 secret을 본다', () => {
  assert.equal(decideValue(agent('trusted'), 'DB_PASSWORD', 'secret', policy).effect, 'allow');
});

test('알 수 없는 에이전트 id는 * 기준선만 받는다', () => {
  assert.equal(decideValue(agent('unknown'), 'ANY_TOPIC', 'public', policy).effect, 'deny');
});

test('* 규칙과 개별 규칙은 합쳐진다', () => {
  const r = ruleFor('claude-code', policy);
  assert.deepEqual(r.allow, ['*_TOPIC', 'ORDER_SERVICE_HOST']);
  assert.equal(r.aliasWrite, true);
});

test('에이전트는 alias 추가만 할 수 있고 교체·삭제는 사람 몫이다', () => {
  assert.equal(decideAliasWrite(agent('claude-code'), 'add', policy).effect, 'allow');
  assert.equal(decideAliasWrite(agent('claude-code'), 'replace', policy).effect, 'deny');
  assert.equal(decideAliasWrite(agent('claude-code'), 'delete', policy).effect, 'deny');
  assert.equal(decideAliasWrite(owner, 'delete', policy).effect, 'allow');
});

test('alias_write가 꺼진 에이전트는 추가도 못 한다', () => {
  assert.equal(decideAliasWrite(agent('codex'), 'add', policy).effect, 'deny');
});

test('글로브는 * 만 지원하고 정규식 문자를 그대로 먹지 않는다', () => {
  assert.equal(globMatch('*_TOPIC', 'A_TOPIC'), true);
  assert.equal(globMatch('*_TOPIC', 'A_TOPICX'), false);
  assert.equal(globMatch('A.B', 'AxB'), false);
});
