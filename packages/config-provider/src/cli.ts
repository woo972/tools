#!/usr/bin/env node
/**
 * dkc CLI — 사람과 쉘이 쓰는 진입점 (스펙 §4.11).
 *
 * 설계 원칙 하나: **값을 셸에 남기지 않는다.**
 * 그래서 `dkc exec`를 1급 명령으로 둔다. 값을 출력해 사람이 복사·붙여넣기 하는 대신
 * 자식 프로세스의 환경변수로 주입한다 — 셸 히스토리·스크롤백에 평문이 남지 않고,
 * 에이전트가 명령을 대신 실행할 때도 값이 컨텍스트에 들어오지 않는다.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DevkitError, toDevkitError } from '#core/errors.ts';
import { call, callOrThrow } from './client.ts';
import { DEFAULT_ENV } from './api.ts';
import { policyPath, publicPath, secretPath, socketPath, sopsRulesPath, storeRoot, uiPort } from './paths.ts';
import { recipientCount, version as sopsVersion } from './sops.ts';

const HERE = import.meta.dirname;
const PKG = join(HERE, '..');

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  // exec는 `--` 뒤의 명령을 그대로 넘겨야 하므로 여기서 플래그를 파싱하지 않는다.
  if (cmd === 'exec') return await cmdExec(rest);

  const flags = parseFlags(rest);

  switch (cmd) {
    case 'get': return await cmdGet(flags);
    case 'resolve': return await cmdResolve(flags);
    case 'set': return await cmdSet(flags);
    case 'alias': return await cmdAlias(flags);
    case 'status': return await cmdStatus(flags);
    case 'reload': return await cmdReload(flags);
    case 'daemon': return await cmdDaemon(flags);
    case 'ui': return await cmdUi(flags);
    case 'mcp': return await import('./mcp.ts').then((m) => m.serve()).then(() => 0);
    case 'init': return cmdInit(flags);
    case 'install-hook': return cmdInstallHook();
    case 'doctor': return await cmdDoctor(flags);
    case 'help': case '--help': case '-h': case undefined: usage(); return 0;
    default:
      process.stderr.write(`알 수 없는 명령: ${cmd}\n`);
      usage();
      return 2;
  }
}

function usage(): void {
  process.stdout.write(`dkc — 개인용 Config Provider

조회
  dkc resolve <자연어>              용어 검색 (값 없이 key만)
  dkc get <KEY> [--env prod|dev]    값 조회 (기본 env=dev)
  dkc get <KEY> --raw               참조를 치환하지 않은 템플릿 원본
  dkc exec --with KEY [--with N=KEY] [--env prod] -- <명령>
                                    값을 환경변수로 주입해 명령 실행 (셸에 값이 남지 않음)

편집
  dkc set <KEY> --env dev --value <값>   값 변경 (--unset으로 미설정)
  dkc alias list <KEY>
  dkc alias add <KEY> <별칭>
  dkc alias rm <KEY> <별칭>

운영
  dkc init                          저장소 초기화 (.sops.yaml, config/, policy.yaml)
  dkc daemon start|stop|status|run  데몬 제어 (run은 포그라운드, launchd/systemd용)
  dkc ui                            로컬 UI (127.0.0.1 전용)
  dkc reload                        캐시 재적재
  dkc status                        데몬 상태
  dkc doctor                        환경 진단
  dkc install-hook                  평문 커밋 차단 pre-commit hook 설치
  dkc mcp                           MCP stdio 어댑터 (클라이언트가 실행)

공통 플래그: --json (기계용 출력)
환경변수: DKC_STORE(저장소), DKC_SOCKET(소켓), DKC_POLICY(정책), DKC_UI_PORT
`);
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

async function cmdGet(f: Flags): Promise<number> {
  const key = f._[0];
  if (!key) return fail('사용법: dkc get <KEY> [--env prod|dev] [--raw]');
  const data = await callOrThrow(`/config/${encodeURIComponent(key)}`, {
    query: { env: f.env ?? DEFAULT_ENV, raw: f.raw ? 'true' : undefined },
  });
  if (f.json) return out(data);
  if (data.status === 'unset') {
    process.stderr.write(`${key}(${data.env})는 정의되어 있으나 값이 아직 없습니다.\n`);
    return 3; // "없는 key"(1)와 구분되는 종료 코드 — 스크립트가 두 상황을 다르게 다룰 수 있다
  }
  // 값만 개행 없이 낸다. `PW=$(dkc get DB_PASSWORD)` 형태로 바로 쓰기 위해서다.
  process.stdout.write(data.value);
  if (process.stdout.isTTY) process.stdout.write('\n');
  return 0;
}

async function cmdResolve(f: Flags): Promise<number> {
  const q = f._.join(' ');
  if (!q) return fail('사용법: dkc resolve <자연어>');
  const data = await callOrThrow('/alias/search', { query: { q, limit: f.limit } });
  if (f.json) return out(data);
  if (!data.hits.length) {
    process.stdout.write(`"${q}"와 일치하는 항목이 없습니다.\n`);
    return 1;
  }
  for (const h of data.hits) {
    process.stdout.write(
      `${h.key}  [${h.visibility}${h.resourceType ? ' · ' + h.resourceType : ''}]\n` +
      `  별칭: ${h.alias.join(', ') || '-'}\n` +
      (h.desc ? `  설명: ${h.desc}\n` : '') +
      `  env: ${h.envs.join(', ')}\n`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 편집
// ---------------------------------------------------------------------------

async function cmdSet(f: Flags): Promise<number> {
  const key = f._[0];
  if (!key) return fail('사용법: dkc set <KEY> --env dev --value <값> | --unset');
  if (f.value === undefined && !f.unset) return fail('--value 또는 --unset이 필요합니다');
  const cur = await callOrThrow(`/config/${encodeURIComponent(key)}`, { query: { env: f.env ?? DEFAULT_ENV, raw: 'true' } });
  const data = await callOrThrow(`/value/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { env: f.env ?? DEFAULT_ENV, value: f.unset ? null : f.value, version: cur.version },
  });
  if (f.json) return out(data);
  process.stdout.write(`${key}(${data.env}) → ${data.status}\n`);
  return 0;
}

async function cmdAlias(f: Flags): Promise<number> {
  const [sub, key, ...words] = f._;
  const alias = words.join(' ');
  if (!sub || !key) return fail('사용법: dkc alias list|add|rm <KEY> [별칭]');

  if (sub === 'list') {
    const data = await callOrThrow(`/alias/${encodeURIComponent(key)}`);
    return f.json ? out(data) : plain(`${data.key}: ${data.alias.join(', ') || '(없음)'}`);
  }
  if (sub === 'add') {
    if (!alias) return fail('추가할 별칭을 입력하세요');
    const data = await callOrThrow(`/alias/${encodeURIComponent(key)}`, { method: 'POST', body: { alias } });
    return f.json ? out(data) : plain(`${data.key}: ${data.alias.join(', ')}`);
  }
  if (sub === 'rm') {
    if (!alias) return fail('삭제할 별칭을 입력하세요');
    const data = await callOrThrow(`/alias/${encodeURIComponent(key)}/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    return f.json ? out(data) : plain(`${data.key}: ${data.alias.join(', ') || '(없음)'}`);
  }
  return fail(`알 수 없는 하위 명령: ${sub}`);
}

/**
 * 값을 환경변수로 주입해 명령을 실행한다 (스펙 §4.3).
 * 값이 stdout에도, 셸 히스토리에도, 에이전트 컨텍스트에도 남지 않는 유일한 경로다.
 */
async function cmdExec(argv: string[]): Promise<number> {
  const sep = argv.indexOf('--');
  if (sep < 0) return fail('사용법: dkc exec --with KEY [--with NAME=KEY] [--env prod] -- <명령>');
  const f = parseFlags(argv.slice(0, sep));
  const cmd = argv.slice(sep + 1);
  if (!cmd.length) return fail('실행할 명령이 없습니다');

  const specs = f.withList;
  if (!specs.length) return fail('--with로 주입할 key를 하나 이상 지정하세요');

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    const name = eq < 0 ? spec : spec.slice(0, eq);
    const key = eq < 0 ? spec : spec.slice(eq + 1);
    const data = await callOrThrow(`/config/${encodeURIComponent(key)}`, { query: { env: f.env ?? DEFAULT_ENV } });
    if (data.status !== 'ok') {
      return fail(`${key}(${data.env})의 값이 없습니다 (status=${data.status}). 값을 먼저 채우세요.`);
    }
    env[name] = data.value;
  }

  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  return await new Promise<number>((resolve) => {
    child.on('error', (e) => { process.stderr.write(`${cmd[0]} 실행 실패: ${e.message}\n`); resolve(127); });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

// ---------------------------------------------------------------------------
// 운영
// ---------------------------------------------------------------------------

async function cmdStatus(f: Flags): Promise<number> {
  const data = await callOrThrow('/status');
  if (f.json) return out(data);
  process.stdout.write(
    `모드: ${data.mode}${data.degradedReason ? ` (${data.degradedReason})` : ''}\n` +
    `항목: ${data.items}개 (secret ${data.secretItems}개)\n` +
    `env: ${data.envs.join(', ')} · 기본값 ${data.defaultEnv}\n` +
    `정책: ${data.policyLoaded ? data.policyPath : `${data.policyPath} 없음 → 에이전트 전면 deny`}\n` +
    `적재: ${data.loadedAt}\n` +
    (data.warnings.length ? `경고:\n${data.warnings.map((w: string) => '  - ' + w).join('\n')}\n` : ''),
  );
  return 0;
}

async function cmdReload(f: Flags): Promise<number> {
  const data = await callOrThrow('/reload', { method: 'POST' });
  return f.json ? out(data) : plain(`reload 완료 — ${data.items}개 (${data.mode})`);
}

function pidPath(): string {
  return `${socketPath()}.pid`;
}

async function cmdDaemon(f: Flags): Promise<number> {
  const sub = f._[0] ?? 'status';

  if (sub === 'run') {
    const { start } = await import('./daemon.ts');
    const h = await start();
    writeFileSync(pidPath(), String(process.pid), { mode: 0o600 });
    process.stderr.write(`[info] pid ${process.pid}\n`);
    await new Promise(() => {}); // 시그널 핸들러가 종료를 담당한다
    return 0;
  }

  if (sub === 'start') {
    const r = await call('/health').catch(() => null);
    if (r?.body?.ok) return plain('이미 동작 중입니다.');
    const logFile = join(dirname(socketPath()), 'daemon.log');
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(HERE, 'cli.ts'), 'daemon', 'run'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
    child.unref();
    // 소켓이 뜰 때까지 짧게 기다린다 — 바로 이어지는 dkc 명령이 실패하지 않게.
    for (let i = 0; i < 40; i++) {
      const ok = await call('/health').catch(() => null);
      if (ok?.body?.ok) return plain(`데몬 시작됨 (pid ${child.pid}) — ${socketPath()}`);
      await sleep(50);
    }
    return fail(`데몬이 2초 안에 뜨지 않았습니다. dkc daemon run으로 포그라운드 실행해 원인을 확인하세요.`);
  }

  if (sub === 'stop') {
    if (!existsSync(pidPath())) return fail('pid 파일이 없습니다. 데몬이 떠 있지 않거나 다른 방식으로 기동되었습니다.');
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 죽었으면 그만 */ }
    try { unlinkSync(pidPath()); } catch { /* noop */ }
    return plain(`SIGTERM 전송 (pid ${pid})`);
  }

  if (sub === 'status') {
    const r = await call('/health').catch(() => null);
    return plain(r?.body?.ok ? `up — ${socketPath()}` : `down — ${socketPath()}`);
  }

  return fail(`알 수 없는 하위 명령: ${sub}`);
}

async function cmdUi(f: Flags): Promise<number> {
  const health = await call('/health').catch(() => null);
  if (!health?.body?.ok) return fail('데몬이 떠 있지 않습니다. dkc daemon start를 먼저 실행하세요.');

  const { start } = await import('./ui.ts');
  const h = await start({ port: f.port ? Number(f.port) : uiPort() });
  process.stdout.write(`UI: ${h.url}  (127.0.0.1 전용 · Ctrl+C로 종료)\n`);
  if (!f.noOpen && process.platform === 'darwin') spawnSync('open', [h.url]);
  await new Promise(() => {});
  return 0;
}

// ---------------------------------------------------------------------------
// 초기화 / 진단
// ---------------------------------------------------------------------------

function cmdInit(f: Flags): number {
  const root = storeRoot();
  mkdirSync(join(root, 'config'), { recursive: true, mode: 0o700 });

  const recipient = f.recipient ?? readDefaultRecipient();
  const created: string[] = [];

  if (!existsSync(sopsRulesPath())) {
    writeFileSync(sopsRulesPath(), sopsRulesTemplate(recipient), { mode: 0o644 });
    created.push('.sops.yaml');
  }
  if (!existsSync(publicPath())) {
    copyFileSync(join(PKG, 'examples', 'public.yaml'), publicPath());
    created.push('config/public.yaml');
  }
  if (!existsSync(policyPath())) {
    copyFileSync(join(PKG, 'examples', 'policy.yaml'), policyPath());
    created.push('policy.yaml');
  }
  if (!existsSync(join(root, '.gitignore'))) {
    // age 개인키가 저장소에 흘러드는 경로를 미리 막는다. pre-commit hook이 잡긴 하지만,
    // 두 겹으로 막을 가치가 있는 사고다 (복구 방법이 사실상 없다).
    writeFileSync(join(root, '.gitignore'), [
      '# 런타임 부산물',
      '.*.lock',
      '*.tmp.*',
      'daemon*.log',
      '',
      '# age 개인키는 어떤 이름으로도 들어오면 안 된다',
      'keys.txt',
      '*.agekey',
      '*.key',
      '',
    ].join('\n'));
    created.push('.gitignore');
  }
  if (!existsSync(join(root, '.git'))) {
    spawnSync('git', ['init', '-q'], { cwd: root });
    created.push('.git');
  }

  process.stdout.write(
    (created.length ? `생성: ${created.join(', ')}\n` : '이미 초기화되어 있습니다.\n') +
    `저장소: ${root}\n\n` +
    (recipient
      ? ''
      : '다음 단계 — age 키가 아직 없습니다:\n' +
        '  mkdir -p ~/.config/sops/age && age-keygen -o ~/.config/sops/age/keys.txt\n' +
        '  chmod 600 ~/.config/sops/age/keys.txt\n' +
        '  # 출력된 public key(age1...)를 .sops.yaml의 age 항목에 넣으세요\n') +
    '  dkc install-hook   # 평문 커밋 차단\n' +
    '  dkc doctor         # 남은 문제 확인\n',
  );
  return 0;
}

function readDefaultRecipient(): string | null {
  const p = process.env.SOPS_AGE_KEY_FILE ?? join(homedir(), '.config', 'sops', 'age', 'keys.txt');
  if (!existsSync(p)) return null;
  const m = readFileSync(p, 'utf8').match(/public key: (age1[0-9a-z]+)/);
  return m ? m[1] : null;
}

function sopsRulesTemplate(recipient: string | null): string {
  return `# sops 암호화 규칙.
# public.yaml은 일부러 규칙에 넣지 않는다 — 실수로 암호화되면 평문 관리의 이점이 사라진다.
# recipient는 2개 이상 등록하는 것을 권장한다. 하나를 분실해도 복구할 수 있다 (스펙 §4.1).
creation_rules:
  - path_regex: config/secret\\.yaml$
    encrypted_regex: '^value$'
    age: >-
      ${recipient ?? 'age1여기에_공개키를_넣으세요'}
`;
}

function cmdInstallHook(): number {
  const root = storeRoot();
  const dir = join(root, '.git', 'hooks');
  if (!existsSync(join(root, '.git'))) return fail(`${root}이 git 저장소가 아닙니다. dkc init을 먼저 실행하세요.`);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, 'pre-commit');
  copyFileSync(join(PKG, 'hooks', 'pre-commit'), dst);
  chmodSync(dst, 0o755);
  return plain(`설치: ${dst}`);
}

type Check = { name: string; level: 'ok' | 'warn' | 'fail'; detail: string; fix?: string };

async function cmdDoctor(f: Flags): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const sv = await sopsVersion();
  add(sv
    ? { name: 'sops', level: 'ok', detail: sv }
    : { name: 'sops', level: 'fail', detail: '설치되어 있지 않습니다', fix: 'brew install sops' });

  const ageOk = spawnSync('age', ['--version'], { encoding: 'utf8' }).status === 0;
  add(ageOk
    ? { name: 'age', level: 'ok', detail: '설치됨' }
    : { name: 'age', level: 'fail', detail: '설치되어 있지 않습니다', fix: 'brew install age' });

  const keyFile = process.env.SOPS_AGE_KEY_FILE ?? join(homedir(), '.config', 'sops', 'age', 'keys.txt');
  if (!existsSync(keyFile)) {
    add({ name: 'age 개인키', level: 'warn', detail: `${keyFile} 없음 → 축소 모드로만 동작합니다`, fix: 'age-keygen -o ' + keyFile });
  } else {
    const mode = statSync(keyFile).mode & 0o777;
    add(mode === 0o600
      ? { name: 'age 개인키', level: 'ok', detail: `${keyFile} (0600)` }
      : { name: 'age 개인키', level: 'warn', detail: `${keyFile} 권한이 ${mode.toString(8)}입니다`, fix: `chmod 600 ${keyFile}` });
  }

  const rc = recipientCount();
  add(rc >= 2
    ? { name: 'age recipient', level: 'ok', detail: `${rc}개 등록 — 하나를 잃어도 복구 가능` }
    : rc === 1
      ? { name: 'age recipient', level: 'warn', detail: '1개뿐입니다. 개인키를 분실하면 복구 불가입니다 (스펙 §6)', fix: `.sops.yaml의 age에 백업 키를 추가한 뒤: sops updatekeys ${secretPath()}` }
      : { name: 'age recipient', level: 'fail', detail: `${sopsRulesPath()}에 age recipient가 없습니다`, fix: 'dkc init' });

  for (const [label, p, mustEncrypt] of [['public.yaml', publicPath(), false], ['secret.yaml', secretPath(), true]] as const) {
    if (!existsSync(p)) {
      add({ name: label, level: 'warn', detail: '없음', fix: 'dkc init' });
      continue;
    }
    const enc = /^sops:/m.test(readFileSync(p, 'utf8'));
    if (mustEncrypt) {
      add(enc ? { name: label, level: 'ok', detail: '암호화됨' }
              : { name: label, level: 'fail', detail: '평문 상태입니다 — 커밋하면 유출됩니다', fix: `sops -e -i ${p}` });
    } else {
      add(enc ? { name: label, level: 'fail', detail: '암호화되어 있습니다', fix: '.sops.yaml의 path_regex를 secret.yaml만 잡게 고치세요' }
              : { name: label, level: 'ok', detail: '평문 (정상)' });
    }
  }

  const hook = join(storeRoot(), '.git', 'hooks', 'pre-commit');
  add(existsSync(hook)
    ? { name: 'pre-commit hook', level: 'ok', detail: hook }
    : { name: 'pre-commit hook', level: 'warn', detail: '평문 커밋을 막을 장치가 없습니다', fix: 'dkc install-hook' });

  add(existsSync(policyPath())
    ? { name: '정책 파일', level: 'ok', detail: policyPath() }
    : { name: '정책 파일', level: 'warn', detail: '없음 → 에이전트는 아무 값도 조회할 수 없습니다(기본 deny)', fix: 'dkc init' });

  const sockDir = dirname(socketPath());
  if (existsSync(sockDir)) {
    const mode = statSync(sockDir).mode & 0o777;
    // 고치는 방법으로 chmod를 제안하지 않는다 — /tmp 같은 공유 디렉터리에 소켓을 둔 경우가
    // 대부분인데, 거기에 chmod 700을 걸면 시스템이 망가진다. 경로를 옮기라고 안내한다.
    add(mode === 0o700
      ? { name: '소켓 디렉터리', level: 'ok', detail: `${sockDir} (0700)` }
      : {
          name: '소켓 디렉터리',
          level: 'warn',
          detail: `${sockDir} 권한이 ${mode.toString(8)}입니다 — 다른 사용자가 들여다볼 수 있는 위치입니다`,
          fix: 'DKC_SOCKET을 비워 사용자 전용 런타임 디렉터리($XDG_RUNTIME_DIR 또는 $TMPDIR)를 쓰게 하세요',
        });
  }

  const health = await call('/health').catch(() => null);
  if (health?.body?.ok) {
    const st = await callOrThrow('/status').catch(() => null);
    add(st?.mode === 'full'
      ? { name: '데몬', level: 'ok', detail: `up · ${st.items}개 적재` }
      : { name: '데몬', level: 'warn', detail: `up · 축소 모드 (${st?.degradedReason ?? '이유 불명'})`, fix: 'age 개인키를 두고 dkc reload' });
  } else {
    add({ name: '데몬', level: 'warn', detail: `연결 불가 (${socketPath()})`, fix: 'dkc daemon start' });
  }

  if (f.json) return out({ checks });

  const icon = { ok: '  ok ', warn: 'warn ', fail: 'FAIL ' };
  for (const c of checks) {
    process.stdout.write(`${icon[c.level]} ${c.name}: ${c.detail}\n` + (c.fix ? `       → ${c.fix}\n` : ''));
  }
  const failed = checks.filter((c) => c.level === 'fail').length;
  process.stdout.write(`\n${checks.length}개 검사 · 실패 ${failed}개 · 경고 ${checks.filter((c) => c.level === 'warn').length}개\n`);
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 플래그 파싱
// ---------------------------------------------------------------------------

type Flags = {
  _: string[];
  json?: boolean;
  raw?: boolean;
  unset?: boolean;
  noOpen?: boolean;
  env?: string;
  value?: string;
  limit?: string;
  port?: string;
  recipient?: string;
  withList: string[];
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = { _: [], withList: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': f.json = true; break;
      case '--raw': f.raw = true; break;
      case '--unset': f.unset = true; break;
      case '--no-open': f.noOpen = true; break;
      case '--env': f.env = argv[++i]; break;
      case '--value': f.value = argv[++i]; break;
      case '--limit': f.limit = argv[++i]; break;
      case '--port': f.port = argv[++i]; break;
      case '--recipient': f.recipient = argv[++i]; break;
      case '--with': f.withList.push(argv[++i]); break;
      default:
        if (a.startsWith('--')) throw new DevkitError({ code: 'INPUT_INVALID', message: `알 수 없는 플래그: ${a}`, retryable: false });
        f._.push(a);
    }
  }
  return f;
}

function out(data: unknown): number {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
  return 0;
}

function plain(s: string): number {
  process.stdout.write(s + '\n');
  return 0;
}

function fail(msg: string): number {
  process.stderr.write(msg + '\n');
  return 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    const e = toDevkitError(err);
    // 구조화 에러를 그대로 낸다 — 에이전트가 hint/fixCommand를 읽고 스스로 복구할 수 있게.
    process.stderr.write(JSON.stringify({ ok: false, error: e.toJSON() }, null, 2) + '\n');
    process.exit(1);
  });
