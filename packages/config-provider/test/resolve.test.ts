/**
 * 스펙 §6이 "구현·테스트 시 최우선 검증 대상"으로 지목한 경로.
 * 참조를 통해 secret이 public 항목으로 흘러들 때 실효 visibility가 따라 올라가는지를 본다.
 * 이게 깨지면 secret이 화이트리스트를 우회해 저위험 경로로 샌다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '#config/alias.ts';
import { maxVisibility, resolveValue, validateRefs, MAX_DEPTH } from '#config/resolve.ts';
import type { Item, Visibility } from '#config/model.ts';

function item(key: string, visibility: Visibility, value: Record<string, string | null>, alias: string[] = []): Item {
  return { key, resourceType: null, alias, value, desc: null, ref: null, visibility, locked: false };
}

test('참조를 같은 env 값으로 치환한다', () => {
  const idx = buildIndex([
    item('HOST', 'public', { prod: 'p.example.com', dev: 'd.example.com' }),
    item('URL', 'public', { prod: 'https://{{HOST}}/x', dev: 'https://{{HOST}}/x' }),
  ]);
  assert.equal(resolveValue('URL', 'prod', idx).value, 'https://p.example.com/x');
  assert.equal(resolveValue('URL', 'dev', idx).value, 'https://d.example.com/x');
});

test('secret을 참조하는 public 항목의 실효 visibility는 secret이다', () => {
  const idx = buildIndex([
    item('DB_PASSWORD', 'secret', { dev: 'pw' }),
    item('DB_URL', 'public', { dev: 'postgres://u:{{DB_PASSWORD}}@h/db' }),
  ]);
  const r = resolveValue('DB_URL', 'dev', idx);
  assert.equal(r.visibility, 'secret');
  assert.equal(maxVisibility('DB_URL', idx), 'secret');
});

test('전이 참조로도 secret이 전파된다 (A → B → SECRET)', () => {
  const idx = buildIndex([
    item('S', 'secret', { dev: 's' }),
    item('B', 'public', { dev: 'b-{{S}}' }),
    item('A', 'public', { dev: 'a-{{B}}' }),
  ]);
  assert.equal(resolveValue('A', 'dev', idx).visibility, 'secret');
  assert.equal(resolveValue('A', 'dev', idx).value, 'a-b-s');
});

test('raw 조회도 실효 visibility를 그대로 계산한다', () => {
  const idx = buildIndex([
    item('S', 'secret', { dev: 's' }),
    item('A', 'public', { dev: 'a-{{S}}' }),
  ]);
  const r = resolveValue('A', 'dev', idx, { raw: true });
  assert.equal(r.value, 'a-{{S}}');
  assert.equal(r.visibility, 'secret');
});

test('한 env에서만 secret을 참조해도 env 없는 자리에서는 보수적으로 secret으로 본다', () => {
  const idx = buildIndex([
    item('S', 'secret', { prod: 's' }),
    item('A', 'public', { prod: '{{S}}', dev: 'plain' }),
  ]);
  assert.equal(resolveValue('A', 'dev', idx).visibility, 'public');
  assert.equal(maxVisibility('A', idx), 'secret');
});

test('순환 참조는 기동 시 실패한다', () => {
  const idx = buildIndex([
    item('A', 'public', { dev: '{{B}}' }),
    item('B', 'public', { dev: '{{A}}' }),
  ]);
  assert.throws(() => validateRefs(idx), (e: any) => e.code === 'CONFIG_REFERENCE_CYCLE');
});

test('자기 자신 참조도 순환이다', () => {
  const idx = buildIndex([item('A', 'public', { dev: 'x{{A}}' })]);
  assert.throws(() => validateRefs(idx), (e: any) => e.code === 'CONFIG_REFERENCE_CYCLE');
});

test('없는 key 참조는 기동 시 경고, 조회 시 에러다', () => {
  const idx = buildIndex([item('A', 'public', { dev: '{{NOPE}}' })]);
  const warnings = validateRefs(idx);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOPE/);
  assert.throws(() => resolveValue('A', 'dev', idx), (e: any) => e.code === 'REF_UNRESOLVED');
});

test('미설정 항목을 참조하면 어떤 참조가 비었는지 알려준다', () => {
  const idx = buildIndex([
    item('P', 'public', { dev: null }),
    item('A', 'public', { dev: 'x{{P}}' }),
  ]);
  assert.throws(() => resolveValue('A', 'dev', idx), (e: any) => e.code === 'REF_UNSET' && /P/.test(e.message));
});

test('참조 깊이 상한을 넘으면 실패한다', () => {
  const items = [item('L0', 'public', { dev: 'end' })];
  for (let i = 1; i <= MAX_DEPTH + 2; i++) items.push(item(`L${i}`, 'public', { dev: `{{L${i - 1}}}` }));
  const idx = buildIndex(items);
  assert.throws(() => resolveValue(`L${MAX_DEPTH + 2}`, 'dev', idx), (e: any) => e.code === 'REF_TOO_DEEP');
});

test('{{{{ 는 리터럴 중괄호다', () => {
  const idx = buildIndex([item('A', 'public', { dev: '{{{{NOT_A_REF}}}}' })]);
  assert.equal(resolveValue('A', 'dev', idx).value, '{{NOT_A_REF}}');
});

test('미설정 값은 404가 아니라 status: unset이다', () => {
  const idx = buildIndex([item('A', 'public', { prod: null, dev: 'x' })]);
  const r = resolveValue('A', 'prod', idx);
  assert.equal(r.status, 'unset');
  assert.equal(r.value, null);
});

test('빈 문자열은 의도적으로 빈 값이며 unset과 다르다', () => {
  const idx = buildIndex([item('A', 'public', { dev: '' })]);
  const r = resolveValue('A', 'dev', idx);
  assert.equal(r.status, 'ok');
  assert.equal(r.value, '');
});

test('잠긴(축소 모드) 항목은 값 대신 locked를 돌려주고 secret으로 취급한다', () => {
  const locked: Item = { ...item('S', 'secret', { dev: null }), locked: true };
  const idx = buildIndex([locked]);
  const r = resolveValue('S', 'dev', idx);
  assert.equal(r.status, 'locked');
  assert.equal(r.visibility, 'secret');
});
