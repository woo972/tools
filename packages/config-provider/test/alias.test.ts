import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, findAliasOwner, normalize, search } from '#config/alias.ts';
import type { Item, Visibility } from '#config/model.ts';

function item(key: string, alias: string[], visibility: Visibility = 'public', desc: string | null = null): Item {
  return { key, resourceType: null, alias, value: { prod: 'p', dev: 'd' }, desc, ref: null, visibility, locked: false };
}

test('정규화는 공백·대소문자·구분자를 무시한다', () => {
  assert.equal(normalize('입고 지시'), normalize('입고지시'));
  assert.equal(normalize('Inbound-Instruction'), normalize('inbound instruction'));
  assert.equal(normalize('ORDER_SERVICE_HOST'), normalize('order service host'));
});

test('두 파일에 걸친 key 중복은 기동 실패다 — 조용한 우선순위를 두지 않는다', () => {
  assert.throws(
    () => buildIndex([item('K', [], 'public'), item('K', [], 'secret')]),
    (e: any) => e.code === 'CONFIG_DUPLICATE_KEY',
  );
});

test('서로 다른 항목이 같은 alias를 쓰면 기동 실패다', () => {
  assert.throws(
    () => buildIndex([item('A', ['입고지시']), item('B', ['입고 지시'])]),
    (e: any) => e.code === 'CONFIG_DUPLICATE_ALIAS',
  );
});

test('중복 alias 주인을 찾아준다 (409 응답에 실린다)', () => {
  const idx = buildIndex([item('A', ['입고지시']), item('B', ['출고지시'])]);
  assert.equal(findAliasOwner('입고 지시', idx), 'A');
  assert.equal(findAliasOwner('입고 지시', idx, 'A'), null); // 자기 자신은 충돌이 아니다
  assert.equal(findAliasOwner('없는말', idx), null);
});

test('검색 결과에는 값이 절대 실리지 않는다 — 2단계 조회 흐름의 전제다', () => {
  const idx = buildIndex([item('INBOUND_INSTRUCTION_TOPIC', ['입고지시'], 'secret')]);
  const [hit] = search('입고 지시', idx);
  assert.equal(hit.key, 'INBOUND_INSTRUCTION_TOPIC');
  assert.deepEqual(hit.envs, ['prod', 'dev']);
  assert.equal(hit.visibility, 'secret');
  assert.equal('value' in hit, false);
  assert.equal(JSON.stringify(hit).includes('"p"'), false);
});

test('정확히 일치하는 alias가 부분 일치보다 위에 온다', () => {
  const idx = buildIndex([
    item('A', ['입고지시']),
    item('B', ['입고지시 재처리']),
  ]);
  assert.equal(search('입고지시', idx)[0].key, 'A');
});

test('설명으로도 찾을 수 있다', () => {
  const idx = buildIndex([item('A', ['x'], 'public', 'WMS 연동 서비스가 소비한다')]);
  assert.equal(search('wms연동', idx)[0].key, 'A');
});

test('일치하는 것이 없으면 빈 배열이다 — 추측해서 아무거나 돌려주지 않는다', () => {
  const idx = buildIndex([item('A', ['입고지시'])]);
  assert.deepEqual(search('전혀다른말', idx), []);
});
