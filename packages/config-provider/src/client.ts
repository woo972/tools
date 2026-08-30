/**
 * UDS 클라이언트 — CLI와 MCP 어댑터가 공유한다.
 *
 * 얇게 유지하는 게 목적이다. 판정(정책·민감도)은 전부 데몬이 하고, 여기서는
 * 전송과 에러 정규화만 한다. 클라이언트가 판정을 흉내내기 시작하면 두 곳이 어긋나고,
 * 어긋난 쪽이 대개 더 느슨하다.
 */

import { request as httpRequest } from 'node:http';
import { DevkitError } from '#core/errors.ts';
import { socketPath } from './paths.ts';
import type { CallerKind } from './policy.ts';

export type CallOptions = {
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  caller?: CallerKind;
  agentId?: string;
  socket?: string;
  timeoutMs?: number;
};

export type CallResult = { status: number; body: any };

export async function call(path: string, opts: CallOptions = {}): Promise<CallResult> {
  const sock = opts.socket ?? socketPath();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v);
  const url = qs.toString() ? `${path}?${qs}` : path;
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);

  return new Promise<CallResult>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sock,
        path: url,
        method: opts.method ?? 'GET',
        // 커넥션 풀을 쓰지 않는다. 전역 Agent는 socketPath별로 소켓을 재사용하는데,
        // 데몬이 재기동되면 죽은 소켓을 그대로 꺼내 써서 EPIPE가 난다 — 장수 프로세스인
        // UI 프록시에서 실제로 터진다. 로컬 UDS라 연결 비용이 사실상 없으므로 매번 새로 연다.
        agent: false,
        headers: {
          'x-dkc-caller': opts.caller ?? 'owner',
          ...(opts.agentId ? { 'x-dkc-agent-id': opts.agentId } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            reject(new DevkitError({
              code: 'DAEMON_BAD_RESPONSE',
              message: '데몬 응답을 JSON으로 읽을 수 없습니다',
              retryable: true,
            }));
          }
        });
      },
    );

    req.setTimeout(opts.timeoutMs ?? 5_000, () => {
      req.destroy(new DevkitError({
        code: 'DAEMON_TIMEOUT',
        message: `데몬이 ${opts.timeoutMs ?? 5000}ms 안에 응답하지 않았습니다`,
        hint: '복호화 중이거나 큰 파일을 쓰는 중일 수 있습니다. 잠시 후 다시 시도하세요.',
        retryable: true,
      }));
    });

    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new DevkitError({
          code: 'DAEMON_UNAVAILABLE',
          message: `데몬에 연결할 수 없습니다 (${sock})`,
          hint: '데몬이 떠 있지 않거나 소켓 경로가 다릅니다. DKC_SOCKET 환경변수를 확인하세요.',
          fixCommand: 'dkc daemon start',
          retryable: true,
        }));
        return;
      }
      reject(err);
    });

    if (payload) req.end(payload);
    else req.end();
  });
}

/** 성공 응답의 data만 꺼내고, 실패면 데몬이 준 구조화 에러를 그대로 다시 던진다. */
export async function callOrThrow(path: string, opts: CallOptions = {}): Promise<any> {
  const r = await call(path, opts);
  if (r.status >= 200 && r.status < 300 && r.body?.ok) return r.body.data;
  const e = r.body?.error;
  throw new DevkitError({
    code: e?.code ?? 'DAEMON_ERROR',
    message: e?.message ?? `데몬이 ${r.status}를 돌려줬습니다`,
    hint: e?.hint,
    fixCommand: e?.fixCommand,
    retryable: e?.retryable ?? false,
    // 데몬이 준 source를 그대로 물려준다. 안 넘기면 이 파일의 위치로 덮여서
    // 에이전트가 엉뚱한 곳(클라이언트)을 고치러 간다.
    source: e?.source,
    details: e?.details,
  });
}
