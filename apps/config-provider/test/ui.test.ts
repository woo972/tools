import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { start } from '../src/ui.ts';

function get(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('UI는 loopback에 바인딩하면서 고정 localhost 이름을 공개하고 허용한다', async () => {
  const ui = await start({ port: 0 });
  try {
    const url = new URL(ui.url);
    assert.equal(ui.address, '127.0.0.1');
    assert.equal(url.hostname, 'config-provider.localhost');

    const response = await get(Number(url.port), 'config-provider.localhost');
    assert.equal(response.status, 200);
    assert.match(response.body, /<title>Config Provider<\/title>/);
  } finally {
    await ui.close();
  }
});

test('UI는 loopback이 아닌 Host 요청을 계속 거부한다', async () => {
  const ui = await start({ port: 0 });
  try {
    const response = await get(Number(new URL(ui.url).port), 'attacker.example');
    assert.equal(response.status, 403);
  } finally {
    await ui.close();
  }
});

// 스크롤 계약. shell은 높이가 inset으로 고정된 그리드라서, 행 크기를 명시하지 않으면
// 행이 콘텐츠만큼 늘어나 좌/우 패널이 화면 밖으로 밀려나고 안쪽 overflow-y:auto가
// 죽는다 — 관리 키가 늘어날수록 아래쪽 키에 닿을 수 없게 된다. 실제로 겪은 회귀다.
test('UI 골격은 안쪽 패널이 스크롤되도록 행 높이를 고정한다', async () => {
  const ui = await start({ port: 0 });
  try {
    const { body } = await get(Number(new URL(ui.url).port), '127.0.0.1');
    const css = body.slice(0, body.indexOf('</style>'));

    const rule = (selector: string): string => {
      const at = css.indexOf(`\n  ${selector} {`);
      assert.notEqual(at, -1, `${selector} 규칙을 찾지 못했습니다`);
      return css.slice(at, css.indexOf('}', at));
    };

    assert.match(rule('.shell'), /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    for (const selector of ['.left', '.right', '.tree']) {
      assert.match(rule(selector), /min-height:\s*0/, `${selector}에 min-height:0이 없습니다`);
    }
  } finally {
    await ui.close();
  }
});
