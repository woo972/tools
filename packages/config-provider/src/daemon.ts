/**
 * Config Daemon — UDS 위의 REST 서버 (스펙 §4.2).
 *
 * 이 파일이 다루는 진짜 문제는 HTTP가 아니라 **소켓 파일 잔존**이다.
 * UDS는 파일시스템 객체라서 프로세스가 SIGKILL로 죽으면 소켓 파일이 남고, 재기동 시
 * bind가 EADDRINUSE로 실패한다. 그렇다고 기동할 때마다 unlink하면 정상 동작 중인
 * 데몬의 소켓을 지워 기존 연결을 끊는다 — 중복 실행과 stale 파일은 겉보기에 같다.
 *
 * 해결: 먼저 **connect를 시도한다.** 붙으면 살아있는 데몬이므로 기동을 포기하고,
 * 거부되면 stale이므로 삭제 후 bind한다. 이 판별을 건너뛰는 지름길을 두지 않는다.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, existsSync, unlinkSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { DevkitError, toDevkitError } from '#core/errors.ts';
import { handle, invalidatePolicy, type ApiRequest } from './api.ts';
import { current, reload } from './cache.ts';
import type { Caller } from './policy.ts';
import { ensureSocketDir, publicPath, secretPath, socketPath } from './paths.ts';

const MAX_BODY = 1 << 20; // 1MB. 설정값 하나가 이보다 클 이유가 없다.

export type DaemonHandle = { close: () => Promise<void>; socket: string };

export async function start(opts: { socket?: string; quiet?: boolean } = {}): Promise<DaemonHandle> {
  const sock = opts.socket ?? socketPath();
  const log = opts.quiet ? () => {} : (s: string) => process.stderr.write(s + '\n');

  // 1) 캐시 적재. 여기서 실패하면(중복 key·순환 참조) 기동 자체를 포기한다 —
  //    조용히 절반만 도는 데몬보다 안 뜨는 데몬이 낫다.
  const snap = await reload();
  for (const w of snap.warnings) log(`[warn] ${w}`);
  if (snap.mode === 'reduced') {
    log(`[warn] 축소 모드로 기동합니다 — secret 값 조회 불가. 이유: ${snap.degradedReason}`);
  }
  log(`[info] 항목 ${snap.items.length}개 적재 (${snap.mode})`);

  // 2) 소켓 자리 확보
  const fromSocketActivation = process.env.LISTEN_FDS === '1';
  if (!fromSocketActivation) await claimSocket(sock, log);

  const server = createServer((req, res) => void serve(req, res, log));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // systemd socket activation: init이 만든 fd 3을 그대로 받는다. 소켓 생성·권한·정리를
    // init이 담당하므로 stale 처리가 아예 불필요해진다 (스펙 §4.2 권장 경로).
    if (fromSocketActivation) server.listen({ fd: 3 }, resolve);
    else server.listen(sock, resolve);
  });

  if (!fromSocketActivation) {
    chmodSync(sock, 0o600); // 소켓 파일 권한이 유일한 접근 제어다 (스펙 §2)
    log(`[info] listening on ${sock}`);
  } else {
    log('[info] listening on socket-activated fd 3');
  }

  const stopWatch = opts.quiet === true || process.env.DKC_WATCH === '0' ? () => {} : watchConfig(log);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopWatch();
    await new Promise<void>((r) => server.close(() => r()));
    // 정상 종료 경로에서 소켓 파일을 지운다. 다음 기동이 stale 판별을 하지 않아도 되게.
    if (!fromSocketActivation) { try { unlinkSync(sock); } catch { /* 이미 없으면 그만 */ } }
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void close().then(() => process.exit(0)));
  }

  return { close, socket: sock };
}

/**
 * 소켓 경로를 확보한다. 살아있는 데몬이 있으면 기동하지 않는다.
 */
async function claimSocket(sock: string, log: (s: string) => void): Promise<void> {
  ensureSocketDir();
  if (!existsSync(sock)) return;

  const alive = await probe(sock);
  if (alive) {
    throw new DevkitError({
      code: 'DAEMON_ALREADY_RUNNING',
      message: `이미 데몬이 ${sock}에서 동작 중입니다`,
      hint: '중복 실행입니다. 기존 데몬을 쓰거나 dkc daemon stop 후 다시 시작하세요.',
      fixCommand: 'dkc daemon stop',
      retryable: false,
    });
  }
  log(`[warn] stale 소켓을 정리합니다: ${sock}`);
  unlinkSync(sock);
}

/** 소켓에 붙어보고 살아있는지 판정한다. 200ms면 로컬 UDS에는 충분하다. */
export function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(sock);
    const done = (v: boolean) => { c.destroy(); resolve(v); };
    c.setTimeout(200, () => done(false));
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}

/**
 * 파일 변경 감지 reload. 저장소를 git pull 하거나 에디터로 직접 고쳤을 때를 위한 편의다.
 * 디바운스를 두는 이유: 원자적 교체(tmp + rename)가 이벤트를 여러 번 만든다.
 */
function watchConfig(log: (s: string) => void): () => void {
  const dir = dirname(publicPath());
  if (!existsSync(dir)) return () => {};
  let timer: NodeJS.Timeout | null = null;
  const watcher = watch(dir, (_e, file) => {
    if (file !== 'public.yaml' && file !== 'secret.yaml') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      invalidatePolicy();
      reload().then(
        (s) => log(`[info] 파일 변경 감지 → reload 완료 (${s.items.length}개, ${s.mode})`),
        // 실패해도 기존 캐시는 그대로다 (cache.ts). 에러만 알리고 계속 돈다.
        (err) => log(`[warn] reload 실패, 기존 캐시 유지 — ${toDevkitError(err).code}`),
      );
    }, 150);
  });
  return () => watcher.close();
}

async function serve(req: IncomingMessage, res: ServerResponse, log: (s: string) => void): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let body: unknown = null;

  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch (err) {
    return send(res, 400, { ok: false, error: toDevkitError(err).toJSON() });
  }

  const apiReq: ApiRequest = {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    body,
    caller: callerOf(req),
  };

  const { status, body: out } = await handle(apiReq, (line) => {
    // 로그에는 key와 결과 코드만 남긴다. 값은 절대 남기지 않는다 (스펙 §4.2).
    log(`[req] ${line.method} ${line.path} → ${line.status}${line.code ? ` ${line.code}` : ''}`);
  });
  send(res, status, out);
}

/**
 * 호출자 판별.
 *
 * 정직하게 말하면 이건 인증이 아니다. 소켓에 닿을 수 있는 프로세스는 어떤 헤더든 보낼 수
 * 있고, 이 설계의 보안 경계는 OS 유저 계정이다(스펙 §6). 이 헤더의 목적은 **에이전트
 * 경로를 좁게 유지**하는 것 — MCP 어댑터는 언제나 agent로 보내고, 그래서 에이전트가
 * 실수로 소유자 전용 경로(값 변경)를 건드리는 일이 없다.
 * 기본값을 agent로 둔 것도 같은 이유다. 헤더를 빠뜨리면 안전한 쪽으로 떨어진다.
 */
function callerOf(req: IncomingMessage): Caller {
  const kind = req.headers['x-dkc-caller'] === 'owner' ? 'owner' : 'agent';
  const id = req.headers['x-dkc-agent-id'];
  return { kind, agentId: kind === 'owner' ? 'owner' : (typeof id === 'string' && id ? id : 'unknown') };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(new DevkitError({ code: 'INPUT_INVALID', message: '요청 본문이 1MB를 넘습니다', retryable: false }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 값이 중간 캐시나 브라우저 디스크 캐시에 남지 않게 한다 (스펙 §4.4).
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** `dkc status`가 쓰는 요약. 데몬 안에서만 의미가 있다. */
export function snapshotSummary(): { mode: string; items: number } {
  const s = current();
  return { mode: s.mode, items: s.items.length };
}

if (import.meta.filename === process.argv[1]) {
  start().catch((err) => {
    const e = toDevkitError(err);
    process.stderr.write(JSON.stringify({ ok: false, error: e.toJSON() }, null, 2) + '\n');
    process.exit(1);
  });
}

// secretPath는 doctor/문서에서 참조하므로 재수출해 둔다.
export { publicPath, secretPath };
