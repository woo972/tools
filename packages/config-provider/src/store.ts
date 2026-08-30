/**
 * File Writer + 파일 락 (스펙 §2.3).
 *
 * 쓰기 경로에서 지키는 세 가지:
 *   - 파일 단위 락으로 직렬화 → 두 surface(UI·MCP)가 동시에 써도 한쪽이 사라지지 않는다
 *   - 원자적 교체(임시 파일 + rename) → 쓰다 죽어도 반쪽짜리 설정 파일이 남지 않는다
 *   - secret은 0600으로 생성 → umask에 의존하지 않는다
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DevkitError } from '#core/errors.ts';
import { parseDocument, serializeDocument, type Item, type Visibility } from './model.ts';
import { publicPath, secretPath, storeRoot } from './paths.ts';
import { encrypt, isEncrypted, tryDecrypt } from './sops.ts';

export const PUBLIC_HEADER = [
  '# public.yaml — 공개 가능한 설정값 (평문, git 그대로 커밋)',
  '# 값 자체가 민감하면 secret.yaml로 옮기세요. key는 두 파일 전체에서 유일해야 합니다.',
  '# 이 파일은 dkc가 다시 쓸 수 있습니다. 주석은 이 헤더만 보존됩니다.',
].join('\n');

export const SECRET_HEADER = [
  '# secret.yaml — 민감값 (sops+age로 value 필드만 암호화)',
  '# 평문 상태로 커밋하지 마세요. hooks/pre-commit이 막습니다.',
  '# 이 파일은 dkc가 다시 쓸 수 있습니다. 주석은 이 헤더만 보존됩니다.',
].join('\n');

export type LoadResult = {
  items: Item[];
  /** full = secret 복호화 성공, reduced = 축소 모드(값 잠김) */
  mode: 'full' | 'reduced';
  /** 축소 모드로 내려간 이유. 사람이 읽는 문장. */
  degradedReason: string | null;
  warnings: string[];
};

/**
 * 두 파일을 읽어 항목 목록을 만든다.
 *
 * secret 복호화가 실패해도 전체 기동을 포기하지 않는다(스펙 §4.2). 암호문 파일에서도
 * key/alias/desc/ref/resource_type은 평문이므로(§5.3) alias 검색은 계속 동작한다.
 * 값만 잠긴 상태(locked)로 두고, 값 조회에서만 명확히 실패시킨다.
 */
export async function loadAll(): Promise<LoadResult> {
  const warnings: string[] = [];
  const items: Item[] = [];

  const pub = publicPath();
  if (existsSync(pub)) {
    const text = readFileSync(pub, 'utf8');
    if (isEncrypted(text)) {
      throw new DevkitError({
        code: 'PUBLIC_UNEXPECTEDLY_ENCRYPTED',
        message: 'public.yaml이 암호화되어 있습니다',
        hint: '.sops.yaml의 path_regex가 public.yaml까지 잡고 있습니다. secret.yaml만 매칭되게 고치세요.',
        retryable: false,
      });
    }
    items.push(...parseDocument(text, 'public', 'public.yaml'));
  } else {
    warnings.push(`${pub}이 없습니다 — public 항목 없이 기동합니다`);
  }

  const sec = secretPath();
  if (!existsSync(sec)) {
    warnings.push(`${sec}이 없습니다 — secret 항목 없이 기동합니다`);
    return { items, mode: 'full', degradedReason: null, warnings };
  }

  const dec = await tryDecrypt(sec);
  if (dec.ok) {
    items.push(...parseDocument(dec.text, 'secret', 'secret.yaml'));
    return { items, mode: 'full', degradedReason: null, warnings };
  }

  // 축소 모드: 암호문에서 평문 메타데이터만 건져 온다.
  const raw = readFileSync(sec, 'utf8');
  const metaOnly = parseDocument(raw, 'secret', 'secret.yaml(암호문)', { locked: true }).map((it) => ({
    ...it,
    // 암호문(ENC[...])이 값으로 새어나가지 않게 비운다. env 목록은 유지해 UI가 표시할 수 있게 한다.
    value: Object.fromEntries(Object.keys(it.value).map((e) => [e, null])) as Record<string, string | null>,
  }));
  items.push(...metaOnly);
  warnings.push(`secret 값을 복호화하지 못했습니다 — ${dec.reason}`);
  return { items, mode: 'reduced', degradedReason: dec.reason, warnings };
}

/** 원자적 파일 교체. secret은 0600으로 만든다. */
function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

/**
 * 항목 목록을 파일에 반영한다. secret이면 sops로 재암호화한 뒤 쓴다.
 * 재암호화는 공개키만 있으면 되지만, sops가 MAC을 다시 계산해야 하므로 실제로는
 * 개인키가 필요하다 — 그래서 축소 모드에서는 호출자가 미리 막아야 한다(스펙 §4.5).
 */
export async function writeItems(visibility: Visibility, items: Item[]): Promise<void> {
  if (visibility === 'public') {
    writeAtomic(publicPath(), serializeDocument(items, PUBLIC_HEADER), 0o644);
    return;
  }
  const plaintext = serializeDocument(items, SECRET_HEADER);
  const cipher = await encrypt(plaintext, secretPath());
  if (!isEncrypted(cipher)) {
    throw new DevkitError({
      code: 'SECRET_ENCRYPT_FAILED',
      message: 'sops가 암호화되지 않은 결과를 돌려줬습니다 — 쓰기를 중단합니다',
      hint: '.sops.yaml의 creation_rules가 config/secret.yaml에 매칭되는지 확인하세요.',
      fixCommand: 'dkc doctor',
      retryable: false,
    });
  }
  writeAtomic(secretPath(), cipher, 0o600);
}

/**
 * 파일 단위 락. O_EXCL 락 파일로 구현한다.
 *
 * 단일 머신·단일 데몬 전제이므로 이 이상은 필요 없다. 다만 데몬이 SIGKILL로 죽으면
 * 락 파일이 남으므로, 오래된 락(2분)은 stale로 보고 회수한다 — 소켓 파일과 같은 문제다.
 */
const LOCK_TTL_MS = 120_000;

export async function withFileLock<T>(visibility: Visibility, fn: () => Promise<T>): Promise<T> {
  const lock = join(storeRoot(), `.${visibility}.lock`);
  mkdirSync(storeRoot(), { recursive: true });

  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = Date.now() - safeMtime(lock);
      if (age > LOCK_TTL_MS) {
        try { unlinkSync(lock); } catch { /* 다른 쪽이 먼저 치웠으면 그대로 진행 */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new DevkitError({
          code: 'STORE_LOCK_BUSY',
          message: `${visibility}.yaml이 다른 쓰기 작업에 잡혀 있습니다`,
          hint: '잠시 후 다시 시도하세요. 계속 걸리면 저장소의 .lock 파일을 확인하세요.',
          retryable: true,
        });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* 이미 없으면 그만 */ }
  }
}

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}
