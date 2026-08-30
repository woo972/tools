/**
 * config-provider가 쓰는 모든 경로의 단일 출처.
 *
 * devkit의 다른 경로(`#core/paths.ts`)와 분리한 이유: 이 서비스는 devkit 런타임 데이터가
 * 아니라 "사용자의 개인 설정 저장소"를 다룬다. 저장소는 git으로 관리되는 별도 디렉터리이며
 * `~/.devkit` 아래에 두면 실수로 devkit 캐시와 함께 지워질 수 있다.
 *
 * 테스트는 DKC_STORE / DKC_SOCKET 두 환경변수만으로 완전히 격리된다.
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Env = string;

/** 설정 저장소 루트. `.sops.yaml`, `config/`, `policy.yaml`이 여기 있고 git 저장소가 된다. */
export function storeRoot(): string {
  return process.env.DKC_STORE ?? join(homedir(), '.config', 'config-provider');
}

export function publicPath(): string {
  return join(storeRoot(), 'config', 'public.yaml');
}

export function secretPath(): string {
  return join(storeRoot(), 'config', 'secret.yaml');
}

export function sopsRulesPath(): string {
  return join(storeRoot(), '.sops.yaml');
}

export function policyPath(): string {
  return process.env.DKC_POLICY ?? join(storeRoot(), 'policy.yaml');
}

/**
 * UDS 소켓 경로.
 *
 * `/tmp`를 쓰지 않는다 (스펙 §4.2): 다른 사용자와 경로가 섞이고 종료 후에도 파일이 남는다.
 * - Linux: $XDG_RUNTIME_DIR — 로그아웃 시 OS가 정리하고 권한 격리가 기본이다.
 * - macOS: $TMPDIR — XDG_RUNTIME_DIR이 없고, macOS의 $TMPDIR은 이미 사용자 전용
 *   (`/var/folders/<hash>/T/`, 0700)이라 같은 성질을 가진다.
 *
 * UDS 경로는 sun_path 제한(macOS 104바이트)이 있어 짧게 유지한다.
 */
export function socketPath(): string {
  if (process.env.DKC_SOCKET) return process.env.DKC_SOCKET;
  const base =
    process.env.XDG_RUNTIME_DIR ??
    (process.platform === 'darwin' ? tmpdir() : join(homedir(), '.config-provider'));
  return join(base, 'config-provider', 'daemon.sock');
}

/** 소켓의 부모 디렉터리를 0700으로 만든다. 소켓 자체 권한(0600)과 이중 방어. */
export function ensureSocketDir(): string {
  const dir = join(socketPath(), '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** UI가 붙는 loopback 포트. 0이면 임의 포트를 잡고 실제 주소를 출력한다. */
export function uiPort(): number {
  return Number(process.env.DKC_UI_PORT ?? 7777);
}
