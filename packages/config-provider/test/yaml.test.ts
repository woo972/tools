import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, YamlError } from '#config/yaml.ts';

test('블록 맵·시퀀스·플로 시퀀스·null·행말 주석을 읽는다', () => {
  const doc = parse(`
items:
  - key: A
    alias: ["가", "나"]
    value:
      prod: null          # 아직 발급 전
      dev: "d"
    desc: "설명"
`) as any;
  assert.equal(doc.items.length, 1);
  assert.deepEqual(doc.items[0].alias, ['가', '나']);
  assert.equal(doc.items[0].value.prod, null);
  assert.equal(doc.items[0].value.dev, 'd');
  assert.equal(doc.items[0].desc, '설명');
});

test('값 안의 콜론을 키로 오인하지 않는다', () => {
  const doc = parse('url: "postgres://h:5432/db"') as any;
  assert.equal(doc.url, 'postgres://h:5432/db');
});

test('sops가 만드는 리터럴 블록을 읽는다 — 축소 모드에서 암호문 파일을 파싱해야 한다', () => {
  const doc = parse(`
sops:
  age:
    - recipient: age1abc
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        line1

        line3
        -----END AGE ENCRYPTED FILE-----
  version: 3.13.3
`) as any;
  assert.match(doc.sops.age[0].enc, /^-----BEGIN/);
  assert.match(doc.sops.age[0].enc, /line1\n\nline3/);
  assert.equal(doc.sops.version, '3.13.3');
});

test('왕복: 파싱 → 직렬화 → 재파싱이 같은 구조를 준다', () => {
  const src = `
items:
  - key: A
    alias: ["별칭 하나"]
    value:
      prod: "p"
      dev: null
  - key: B
    value:
      dev: "x"
`;
  const first = parse(src) as any;
  const again = parse(stringify({ items: first.items })) as any;
  assert.deepEqual(again.items, first.items);
});

test('YAML이 다르게 해석할 수 있는 값도 문자열로 왕복한다', () => {
  // 비밀번호에 흔한 문자들. 평문 스칼라로 내보내면 타입이 바뀌거나 파싱이 깨진다.
  const tricky = { a: 'yes', b: '0755', c: '12:30', d: '*star', e: '#hash', f: 'line1\nline2' };
  const back = parse(stringify(tricky)) as any;
  assert.deepEqual(back, tricky);
});

test('지원하지 않는 문법은 조용히 무시하지 않고 실패한다', () => {
  assert.throws(() => parse('a: &anchor 1'), YamlError);
});
