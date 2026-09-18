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
