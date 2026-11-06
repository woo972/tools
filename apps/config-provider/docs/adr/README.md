# 기술 결정 기록 (ADR)

이 디렉터리는 **왜 그렇게 만들었는지**를 남긴다. 무엇을 만들었는지는 코드와
[`../../README.md`](../../README.md)에 있다.

여기 있는 기록의 목적은 하나다 — **이유를 모르고 "정리"하다 보안 구멍이나 되돌이표를
만드는 것을 막는 것.** 그래서 각 문서는 대안을 왜 버렸는지와, 어떤 조건이면 그 결정을
다시 열어야 하는지를 같이 적는다.

| ADR | 결정 | 범위 | 상태 |
|---|---|---|---|
| [0001](0001-ui-two-panel-tables.md) | UI는 좌 탐색기 · 우 상세 2패널, 값은 전부 표 | config-provider | 채택 |
| [0002](0002-collections-separate-file.md) | 컬렉션은 항목이 아니라 별도 파일에 둔다 | config-provider | 채택 |
| [0003](0003-resource-type-registry.md) | 종류(resource_type)는 등록된 목록에서만 고른다 | config-provider | 채택 |
| [0004](0004-raycast-isolated-package.md) | Raycast 확장은 격리된 npm 패키지로 둔다 | config-provider | 채택 |
| [0005](0005-compile-cache-not-build.md) | 타입 스트리핑 고정비는 빌드가 아니라 컴파일 캐시로 없앤다 | 저장소 전체 | 채택 |
| [0006](0006-transport-uds-http1.md) | 전송은 UDS + HTTP/1.1을 유지한다 (gRPC 기각) | config-provider | 채택 |

devkit 전체의 기술 결정(ADR-001~005)은 [`plan.md` §14](../../../../plan.md)에 있다.

## 쓰는 법

되돌리기 어렵거나, 나중에 "왜 이렇게 했지"가 나올 결정만 적는다. 형식은 맥락 → 결정 →
근거 → 기각한 대안 → 결과 → **재검토 조건** 순서다. 마지막 항목이 핵심이다 — 조건 없이
"채택"만 적힌 기록은 시간이 지나면 그냥 관성이 된다.
