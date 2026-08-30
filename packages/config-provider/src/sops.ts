/**
 * Crypto Gateway — sops 호출을 독점하는 유일한 자리 (스펙 §2.3).
 *
 * 이걸 한 곳에 가둔 이유는 두 가지다.
 *   1) 성능: 복호화는 기동/reload 시점에만 일어나고 조회 경로에는 절대 끼지 않는다.
 *      sops 프로세스를 요청마다 띄우면 에이전트의 병렬 조회가 그대로 병목이 된다.
 *   2) 유출: 평문은 여기 들어왔다 여기서만 나간다. 아래 두 규칙을 이 파일에서만 지키면
 *      나머지 코드는 평문 유출을 걱정할 필요가 없다.
 *        - 평문을 임시 파일로 디스크에 쓰지 않는다 → stdin으로 넘긴다
 *        - sops의 stdout(= 평문)을 에러 메시지나 로그에 절대 싣지 않는다
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DevkitError } from '#core/errors.ts';
import { sopsRulesPath } from './paths.ts';

const SOPS = process.env.DKC_SOPS_BIN ?? 'sops';

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOPS, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new DevkitError({
          code: 'SOPS_NOT_INSTALLED',
          message: `sops를 찾을 수 없습니다 (${SOPS})`,
          hint: 'brew install sops age — 설치 후 dkc doctor로 다시 확인하세요.',
          fixCommand: 'brew install sops age',
          retryable: false,
        }));
        return;
      }
      reject(err);
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** 파일이 sops로 암호화된 상태인지. 평문 파일을 복호화하려다 실패하는 걸 피한다. */
export function isEncrypted(text: string): boolean {
  return /^sops:/m.test(text) || text.includes('ENC[AES256_GCM');
}

/**
 * secret.yaml → 평문 YAML 문자열.
 * 실패해도 예외 대신 결과 객체를 돌려준다 — 호출자(cache)가 축소 모드로 내려가야 하기 때문에
 * "실패"가 정상 흐름의 일부다 (스펙 §4.2 기동 실패 처리).
 */
export async function tryDecrypt(file: string): Promise<{ ok: true; text: string } | { ok: false; reason: string; code: string }> {
  if (!existsSync(file)) {
    return { ok: false, reason: `${file}이 없습니다`, code: 'SECRET_FILE_MISSING' };
  }
  const raw = readFileSync(file, 'utf8');
  if (!isEncrypted(raw)) {
    return { ok: false, reason: `${file}이 암호화되어 있지 않습니다`, code: 'SECRET_NOT_ENCRYPTED' };
  }
  const r = await run(['decrypt', '--input-type', 'yaml', '--output-type', 'yaml', file]);
  if (r.code !== 0) {
    // stderr만 싣는다. stdout은 (부분적일지라도) 평문이므로 어디에도 남기지 않는다.
    return { ok: false, reason: firstLine(r.stderr) || `sops decrypt 실패 (exit ${r.code})`, code: 'SECRET_DECRYPT_FAILED' };
  }
  return { ok: true, text: r.stdout };
}

/**
 * 평문 YAML → 암호문 YAML.
 *
 * `--filename-override`로 실제 저장 경로를 알려주면 sops가 그 경로 기준으로 `.sops.yaml`의
 * creation_rules(recipient, encrypted_regex)를 찾는다. 덕분에 recipient 목록을 이 코드가
 * 중복 관리하지 않아도 되고, 규칙의 단일 출처가 `.sops.yaml` 하나로 유지된다.
 */
export async function encrypt(plaintext: string, targetPath: string): Promise<string> {
  if (!existsSync(sopsRulesPath())) {
    throw new DevkitError({
      code: 'SOPS_RULES_MISSING',
      message: `${sopsRulesPath()}이 없습니다`,
      hint: 'dkc init으로 저장소를 만들거나 .sops.yaml에 creation_rules를 추가하세요.',
      fixCommand: 'dkc init',
      retryable: false,
    });
  }
  // --config를 명시적으로 넘긴다. sops는 `.sops.yaml`을 **현재 작업 디렉터리** 기준으로
  // 찾는데, 데몬의 cwd는 저장소와 무관하다. 이걸 빠뜨리면 creation rules를 못 찾아 실패하거나
  // — 더 나쁘게는 전혀 다른 저장소의 규칙을 주워 쓴다.
  const r = await run(
    ['--config', sopsRulesPath(),
     'encrypt', '--filename-override', targetPath, '--input-type', 'yaml', '--output-type', 'yaml', '/dev/stdin'],
    plaintext,
  );
  if (r.code !== 0) {
    throw new DevkitError({
      code: 'SECRET_ENCRYPT_FAILED',
      message: `sops encrypt 실패 — ${firstLine(r.stderr) || `exit ${r.code}`}`,
      hint: '.sops.yaml의 path_regex가 config/secret.yaml에 매칭되는지, age recipient가 유효한지 확인하세요.',
      fixCommand: 'dkc doctor',
      retryable: false,
    });
  }
  return r.stdout;
}

/** sops 설치 여부와 버전. doctor 전용. */
export async function version(): Promise<string | null> {
  try {
    const r = await run(['--version', '--disable-version-check']);
    return r.code === 0 ? firstLine(r.stdout) : null;
  } catch {
    return null;
  }
}

/** `.sops.yaml`에 등록된 age recipient 수. 1개면 키 분실 시 복구 불가(스펙 §4.1). */
export function recipientCount(): number {
  const p = sopsRulesPath();
  if (!existsSync(p)) return 0;
  const text = readFileSync(p, 'utf8');
  const m = text.match(/age1[0-9a-z]{10,}/g);
  return m ? new Set(m).size : 0;
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}
