/**
 * Memory Cache — 복호화된 설정의 단일 사본 (스펙 §2.3).
 *
 * reload 원자성이 이 파일의 존재 이유다. 파싱이나 복호화가 중간에 실패하면 **기존 캐시를
 * 그대로 유지**하고 에러만 돌려준다. 새 상태를 완전히 다 만든 뒤에야 교체하므로,
 * "절반은 새 값, 절반은 옛 값" 같은 상태가 만들어지지 않는다.
 */

import type { Item } from './model.ts';
import { buildIndex } from './alias.ts';
import { validateRefs, type Index } from './resolve.ts';
import { loadAll } from './store.ts';

export type Snapshot = {
  index: Index;
  items: Item[];
  mode: 'full' | 'reduced';
  degradedReason: string | null;
  warnings: string[];
  loadedAt: number;
};

let state: Snapshot | null = null;

/** 새 스냅샷을 끝까지 만든 뒤 한 번에 교체한다. 실패하면 이전 스냅샷이 그대로 살아있다. */
export async function reload(): Promise<Snapshot> {
  const loaded = await loadAll();
  const index = buildIndex(loaded.items);
  const refWarnings = validateRefs(index); // 순환 참조면 여기서 throw → 교체하지 않음

  const next: Snapshot = {
    index,
    items: loaded.items,
    mode: loaded.mode,
    degradedReason: loaded.degradedReason,
    warnings: [...loaded.warnings, ...refWarnings],
    loadedAt: Date.now(),
  };
  state = next; // ← 교체는 마지막 한 줄. 이 위에서 던지면 아무 일도 일어나지 않는다.
  return next;
}

export function isLoaded(): boolean {
  return state !== null;
}

export function current(): Snapshot {
  if (!state) throw new Error('캐시가 아직 적재되지 않았습니다 — reload()를 먼저 호출하세요');
  return state;
}

/**
 * 쓰기 성공 후 인메모리 상태를 갱신한다 (스펙 §4.5: 편집 후 별도 reload 불필요).
 * 파일 쓰기가 성공한 뒤에만 호출한다 — 실패 시 캐시가 파일보다 앞서가면
 * 다음 조회가 디스크에 없는 값을 돌려주게 된다.
 */
export function replaceItem(next: Item): void {
  const s = current();
  const items = s.items.map((it) => (it.key === next.key ? next : it));
  const index = buildIndex(items); // alias 중복은 여기서 다시 걸린다
  validateRefs(index);
  state = { ...s, items, index };
}

/** 테스트 격리용. 프로덕션 경로에서는 쓰지 않는다. */
export function reset(): void {
  state = null;
}
