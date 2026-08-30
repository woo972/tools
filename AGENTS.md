# AGENTS.md — devkit 툴을 추가하거나 고치는 법

이 문서는 **AI 에이전트가 읽는 문서**다. devkit 툴이 잘못 동작할 때,
또는 새 툴을 추가할 때 여기 적힌 절차를 그대로 따르면 된다.

전체 설계 의도는 `plan.md`에 있다. 이 파일은 실행 절차만 담는다.

---

## 0. 30초 요약

```bash
./bin/dk list                                  # 어떤 툴이 있나
./bin/dk describe <tool>                       # 계약(입출력 스키마) 확인
./bin/dk run <tool> --input '<json>'           # 실행
./bin/dk run <tool> --input '<json>' --explain # 실행 없이 계획만 (디버깅 1단계)
./bin/dk test <tool>                           # 골든 + 계약 테스트
./bin/dk doctor                                # 환경 진단 (문제마다 고치는 명령 포함)
```

- 런타임: Node 24. **빌드 단계가 없다.** `.ts`를 Node가 직접 실행한다(type stripping).
- 의존성: **없다.** `npm install`이 필요 없다. SQLite는 `node:sqlite`, 테스트는 `node:test`.
- 따라서 파일을 고치면 바로 반영된다. 재빌드·재설치를 시도하지 마라.

> 설정값(서버 주소·비밀번호·API 키·카프카 토픽명)을 찾고 있다면 `dk`가 아니라 `dkc`다.
> 조회 규칙과 고치는 절차는 [`packages/config-provider/AGENTS.md`](packages/config-provider/AGENTS.md)에 있다.
> 요약: `dkc resolve <자연어>` → key 확인 → `dkc get <KEY>` 또는 (선호) `dkc exec --with N=KEY -- <명령>`.

---

## 1. 툴이 실패했을 때 — 6단계

### 1단계. 에러 출력을 먼저 읽어라

devkit의 모든 에러는 구조화되어 있고 **고칠 위치를 스스로 알려준다.**

```json
{
  "ok": false,
  "error": {
    "code": "OUTPUT_CONTRACT_VIOLATION",
    "message": "'trace-flow'의 출력이 outputSchema와 맞지 않습니다 — $.nodes[0].line: 타입이 integer 이어야 합니다",
    "hint": "index.ts의 반환값 또는 manifest.json의 outputSchema 중 하나가 틀렸습니다.",
    "retryable": false,
    "fixCommand": "dk run repo-map --repo my-service --refresh",
    "source": { "file": "tools/trace-flow/index.ts", "line": 118 }
  }
}
```

- `source` → **바로 이 파일:라인으로 가라.** 스택트레이스를 뒤질 필요 없다.
- `fixCommand` → 있으면 먼저 그대로 실행해봐라. 코드 문제가 아닐 수 있다.
- `retryable: true` → 일시적 문제다(임대 경합 등). 재시도로 풀린다.

### 2단계. 코드 문제인지 환경/설정 문제인지 가른다

```bash
./bin/dk run <tool> --input @repro.json --explain
```

`--explain`은 툴을 **실행하지 않고** 해석된 입력, 정책 결정, 임대 계획, 캐시 상태만 돌려준다.
여기서 이미 이상하면 코드가 아니라 설정 문제다:

- `resolvedInput`이 예상과 다름 → manifest의 `inputSchema` 기본값 문제
- `policy.effect != "allow"` → 정책 문제. `~/.devkit/config.toml`의 `[policy]` 확인
- `cache.hit: true`인데 결과가 낡음 → `--refresh`로 재실행

`--explain`이 정상이면 3단계로 간다.

### 3단계. 재현 입력을 파일로 고정한다

```bash
echo '{"repo":"my-service","entry":"POST /v1/payments"}' > /tmp/repro.json
./bin/dk run <tool> --input @repro.json --refresh --trace
```

- `--refresh`: 캐시를 무시한다. **디버깅 중에는 항상 붙여라.** 안 붙이면 고친 코드가 안 돌아간다.
- `--trace`: 툴 안의 `ctx.log()` 출력을 stderr로 보여준다.

### 4단계. 고친다

- 툴 구현은 `tools/<name>/index.ts` **한 파일**이다.
- **300줄을 넘기지 마라.** 넘을 것 같으면 툴을 둘로 쪼개는 게 맞다.
- `packages/core/`를 고치는 건 최후의 수단이다. 그건 모든 툴에 영향을 준다.

### 5단계. 재현 입력을 회귀 케이스로 남긴다

**이 단계를 건너뛰지 마라.** 같은 버그가 다시 나는 걸 막는 유일한 장치다.

`tools/<name>/fixtures/<설명>.json`:

```json
{
  "name": "동적 디스패치는 unresolved로 보고한다",
  "input": { "repo": "my-service", "entry": "POST /v1/payments" },
  "expect": { "minEvidence": 1, "minConfidence": 0.8 }
}
```

에러가 나는 게 정상인 케이스라면:

```json
{ "name": "인덱스가 없으면 명확히 실패한다", "input": { "repo": "unknown" }, "expectError": "REPO_NOT_CONFIGURED" }
```

`expect`에 쓸 수 있는 것: `data`(부분 일치), `minEvidence`, `confidence`, `minConfidence`.

### 6단계. 검증하고 버전을 올린다

```bash
./bin/dk test <tool>       # 골든 픽스처 + manifest 기반 계약 테스트
npm test                   # core/registry 전체
```

- 동작이 그대로고 버그만 고쳤으면 `manifest.version` **패치** 올림 (1.2.0 → 1.2.1)
- 입출력이 바뀌었으면 **마이너** 올림 (1.2.0 → 1.3.0). 캐시 키에 버전이 들어가므로
  버전을 올리면 낡은 캐시가 자동으로 무효화된다. **꼭 올려라.**

---

## 2. 새 툴 추가

```bash
./bin/dk scaffold tool <name>
```

`manifest.json` + `index.ts` + `fixtures/` + `README.md`가 계약을 지킨 상태로 생성된다.
그다음 채울 것:

### manifest.json에서 반드시 손봐야 하는 것

| 필드 | 왜 중요한가 |
|---|---|
| `whenToUse` | **LLM이 이 툴을 고를지 판단하는 유일한 근거다.** 20자 이상, 구체적으로. "언제 쓰는지"와 "언제 안 쓰는지"를 같이 적어라 |
| `inputSchema.additionalProperties` | `false`로 둬라. 에이전트의 오타를 실행 전에 잡는다 |
| `sideEffects` | `read`가 아니면 정책 게이트가 걸린다. 정직하게 적어라 |
| `concurrency` | 공유 자원(Gradle, DB, 인덱스)을 건드리면 `exclusive` + `resourceKey`. `"gradle:{repo}"`처럼 입력값을 `{}`로 치환할 수 있다 |
| `determinism` | `by-commit`이면 커밋 SHA 기준으로 캐시된다. 외부 시스템을 읽으면 `nondeterministic` |
| `timeoutSec` | 실제 소요의 3배 정도로 |

### index.ts에서 지켜야 하는 것

```ts
export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  return {
    data,                    // outputSchema와 일치해야 한다
    evidence: [...],         // 비면 EVIDENCE_REQUIRED로 실패한다 (설계원칙 P3)
    confidence: 0.86,        // 정적 분석이면 정직하게. 모르면 낮춰라
    unresolved: [...],       // 해석 못 한 것. 숨기지 말고 여기 담아라 (P9)
    nextActions: [...],      // 다음에 뭘 하면 좋을지
  };
}
```

**네 가지 규칙:**

1. **`evidence` 없이 반환하지 마라.** 이게 devkit의 존재 이유다. 파일:라인, 실행한 쿼리,
   실행한 명령 중 하나는 반드시 있어야 한다. 메타 툴이면 manifest에 `evidenceOptional: true`.
2. **모르는 건 `unresolved`에 담아라.** 추측해서 `data`에 넣지 마라. 조용히 틀린 답이
   "모르겠다"보다 훨씬 나쁘다.
3. **출력을 4KB 이하로 유지해라.** 기본은 요약, 상세는 `truncated.cursor`로 페이징.
   출력이 크면 에이전트 컨텍스트가 부풀고, 그게 곧 비용이다(plan.md §1.2).
4. **툴 안에서 LLM을 호출하지 마라.** 툴은 사실만 반환한다. 판단은 호출한 에이전트가 한다.
   비결정적 출력은 캐시·테스트·디버깅이 전부 불가능해진다.

---

## 3. 구조

```
devkit/
├─ bin/dk                     실행 진입점 (경고 억제 후 main.ts 호출)
├─ packages/
│  ├─ core/src/
│  │  ├─ contract.ts          툴 계약 타입 — 여기부터 읽어라
│  │  ├─ errors.ts            구조화 에러 (source 자동 추출)
│  │  ├─ schema.ts            JSON Schema 서브셋 검증기
│  │  ├─ config.ts            설정 5계층 병합
│  │  ├─ secrets.ts           Keychain 참조 해석 + 마스킹
│  │  ├─ db.ts                node:sqlite (WAL)
│  │  ├─ ledger.ts            실행 기록 (JSONL 진실원천 + SQLite 인덱스)
│  │  ├─ lease.ts             배타 자원 임대 (동시성의 핵심)
│  │  ├─ cache.ts             commitSha 기반 결과 캐시
│  │  ├─ policy.ts            정책 게이트 5단계
│  │  └─ toml.ts              TOML 서브셋 파서
│  ├─ registry/src/
│  │  ├─ registry.ts          manifest 스캔·검증
│  │  └─ execute.ts           실행 파이프라인 ★ 모든 surface가 여기로 모인다
│  ├─ cli/src/                dk 명령
│  ├─ mcp/src/stdio.ts        MCP 어댑터 (얇게 유지할 것)
│  └─ config-provider/        개인 설정 저장소 서비스 — 별도 AGENTS.md 있음
└─ tools/<name>/              manifest.json + index.ts + fixtures/
```

**`packages/registry/src/execute.ts`가 중심이다.** CLI든 MCP든 전부 여기로 들어온다.
동작을 바꾸고 싶으면 surface가 아니라 여기를 봐라.

---

## 4. 동시성 — 다른 에이전트와 같이 일할 때

여러 에이전트가 동시에 devkit을 쓴다. 규칙:

```bash
./bin/dk run devkit-observe --input '{"view":"leases"}'   # 누가 뭘 잡고 있나
./bin/dk ps                                              # 실행 중인 툴
```

- **읽기 툴은 무제한 병렬**이다. 그냥 호출해라.
- **배타 자원**(Gradle, DB, 코드 인덱스)은 임대로 보호된다. 점유 중이면 `LEASE_BUSY`가
  `retryable: true`로 온다. `--wait <ms>`로 기다리거나, 순서를 바꿔 다른 일을 먼저 해라.
- 임대는 TTL 10분 + 30초 하트비트다. 에이전트가 죽어도 자동 회수된다. **수동으로
  락을 지우려 하지 마라.**
- 자기 신원을 밝혀라: `--agent <id>` (MCP는 `_meta.agentId`). ledger에 남아서
  누가 뭘 했는지 추적된다.

---

## 5. 해서는 안 되는 것

| 금지 | 이유 |
|---|---|
| npm 패키지 추가 | 의존성 0이 설계 제약이다. 네이티브 빌드가 끼면 툴을 고칠 수 없게 된다 |
| 툴 안에서 LLM 호출 | 비결정적 출력 → 캐시·테스트·디버깅 불가 |
| `evidence` 비우고 반환 | devkit의 존재 이유를 없애는 일이다 |
| 낮은 `confidence`를 1.0으로 올려서 통과시키기 | 조용히 틀린 답을 만든다. 차라리 실패해라 |
| `~/.devkit/config.toml`에 시크릿 평문 저장 | `keychain://service/account` 참조만 쓴다 |
| SQLite 파일 직접 수정 | JSONL이 진실 원천이다. `~/.devkit/devkit.db`는 지워도 되는 파생물 |
| 사내 시스템(Jira/DB/APM) 접근 툴 추가 | **보안 정책 확인 전까지 금지.** plan.md §15-1 참조 |
| config-provider의 정책·민감도 판정을 우회 | `POLICY_DENIED`는 소유자의 의도다. 사람에게 요청해라 |

---

## 6. 자주 나오는 에러

| 코드 | 뜻 | 조치 |
|---|---|---|
| `INPUT_INVALID` | 입력이 계약과 다름 | `dk describe <tool>`로 스키마 확인 |
| `TOOL_NOT_FOUND` | 툴 이름 오타 또는 미등록 | `dk list` |
| `EVIDENCE_REQUIRED` | 툴이 근거 없이 반환 | `tools/<name>/index.ts`에 evidence 추가 |
| `OUTPUT_CONTRACT_VIOLATION` | 반환값이 outputSchema와 불일치 | 둘 중 하나를 맞춰라 |
| `LEASE_BUSY` | 다른 에이전트가 자원 점유 | `--wait 30000` 또는 순서 변경 |
| `TOOL_TIMEOUT` | 시간 초과 | 입력 범위를 좁히거나 `timeoutSec` 상향 |
| `REPO_NOT_CONFIGURED` | 저장소 미등록 | `~/.devkit/config.toml`에 `[repos.<name>]` 추가 |
| `POLICY_APPROVAL_REQUIRED` | 승인 필요 | **사람이 승인해야 한다. 우회하지 마라** |
| `CONFIG_UNSUPPORTED_SYNTAX` | TOML 서브셋 밖 문법 | `packages/core/src/toml.ts` 지원 범위 확인 |
