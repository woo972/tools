/**
 * Local UI 서버 (스펙 §4.4).
 *
 * 이 UI는 본인이 **복호화된 원본 평문을 직접 눈으로 확인하는 유일한 창구**다.
 * 그래서 에이전트 경로와 정반대의 선택을 한다: 값을 그대로 보여주고, 마스킹은
 * 어깨너머 노출을 줄이는 기본 표시 상태일 뿐 토글 한 번에 즉시 풀린다.
 *
 * 노출 경계는 코드 한 줄로 지킨다 — **127.0.0.1에만 바인딩한다.**
 * 0.0.0.0으로 여는 순간 이 설계의 전제(로컬 단일 머신)가 통째로 무너진다.
 * 이 파일은 자체 로직을 갖지 않고 UDS 데몬에 소유자 자격으로 프록시하기만 한다.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toDevkitError } from '#core/errors.ts';
import { call } from './client.ts';
import { uiPort } from './paths.ts';

const HTML = () => readFileSync(join(import.meta.dirname, 'ui.html'), 'utf8');

export type UiHandle = { close: () => Promise<void>; url: string };

export async function start(opts: { port?: number; host?: string } = {}): Promise<UiHandle> {
  const port = opts.port ?? uiPort();
  // 기본값을 상수로 박는다. 환경변수로 host를 바꿀 수 있게 두지 않는다 —
  // 실수로 외부에 노출되는 경로를 아예 만들지 않기 위해서다.
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const url = `http://${host}:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // 브라우저가 아닌 곳에서 온 요청은 거절한다. loopback 바인딩 위의 얇은 이중 방어로,
  // DNS 리바인딩으로 다른 호스트명을 태워 보내는 경로를 막는다.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    res.writeHead(403).end('loopback 전용입니다');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = HTML();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 값이 브라우저 디스크 캐시에 남지 않게 한다. CSP로 외부 전송 경로도 함께 닫는다.
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400).end('{"ok":false}');
      return;
    }
    try {
      const r = await call(url.pathname.slice(4) + (url.search || ''), {
        method: req.method ?? 'GET',
        body,
        caller: 'owner', // UI는 소유자 창구다 (스펙 §4.4)
      });
      const text = JSON.stringify(r.body);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    } catch (err) {
      const e = toDevkitError(err);
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: e.toJSON() }));
    }
    return;
  }

  res.writeHead(404).end('not found');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { d += c; if (d.length > 1 << 20) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
