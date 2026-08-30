# AGENTS.md — config-provider를 쓰는 법 / 고치는 법

이 문서는 **AI 에이전트가 읽는 문서**다. 사람용 설치·운영 문서는 [README.md](README.md)에 있다.

두 가지 상황을 다룬다.
1. §1 — 에이전트로서 설정값을 **조회할 때**
2. §2~ — 이 서비스가 잘못 동작해서 **고쳐야 할 때**

---

## 0. 30초 요약

```bash
dkc resolve <자연어>          # 자연어 → key (값은 안 나온다)
dkc get <KEY> [--env prod]    # 값 조회. env 생략 시 dev
dkc exec --with N=KEY -- <명령>  # 값을 안 보고 명령만 실행 (선호)
dkc status                    # 데몬 상태
dkc doctor                    # 환경 진단 (문제마다 고치는 명령 포함)
```

MCP로 붙었다면 같은 것을 `resolve_alias` / `get_value` / `add_alias` tool로 쓴다.

---

## 1. 값이 필요할 때 — 지켜야 하는 것

### 규칙 1. key를 추측하지 마라. 먼저 검색하라

```
resolve_alias("입고지시")  →  key: INBOUND_INSTRUCTION_TOPIC, visibility: public
get_value("INBOUND_INSTRUCTION_TOPIC", "prod")  →  "moms.inbound.instruction.v1"
```

`resolve_alias`는 **값을 절대 반환하지 않는다.** 그래서 secret 항목까지 안전하게 검색된다.
값이 필요한 순간에만 `get_value`를 부르면 노출이 최소화된다.

### 규칙 2. 값을 몰라도 되면 받지 마라

DB에 붙거나 API를 호출하는 것처럼 **명령만 실행하면 되는 경우**, 값을 받아 명령줄에
끼워 넣지 마라. 값이 대화 컨텍스트·로그·셸 히스토리 세 곳에 동시에 남는다.

```bash
# 나쁨 — 값이 컨텍스트와 히스토리에 남는다
PGPASSWORD=$(dkc get DB_PASSWORD --env prod) psql ...

# 좋음 — 값이 자식 프로세스 환경변수로만 들어간다
dkc exec --with PGPASSWORD=DB_PASSWORD --env prod -- psql -h db.internal -U orders
```

### 규칙 3. env를 명시하라

생략하면 **dev**다. prod 값이 필요하면 반드시 `--env prod` / `{"env":"prod"}`를 써라.
이건 실수로 운영 값을 건드리는 사고를 막으려는 기본값이므로 우회하지 마라.

### 규칙 4. 세 가지 실패를 구별하라

| 응답 | 뜻 | 해야 할 일 |
|---|---|---|
| `status: "ok"` | 값이 있다 | 쓴다 |
| `status: "unset"` (200) | 항목은 있으나 값이 아직 없다 | **사람에게 물어봐라.** 값을 지어내지 마라 |
| `KEY_NOT_FOUND` (404) | key 이름을 잘못 알았다 | `resolve_alias`로 다시 찾아라 |
| `POLICY_DENIED` (403) | 소유자가 의도적으로 막았다 | **우회하지 마라.** 사람에게 허용을 요청하거나 `dkc exec` 방식을 제안하라 |
| `SECRET_UNAVAILABLE` (503) | 축소 모드다 (개인키 없음) | 사람에게 `dkc reload`를 요청하라 |
| `REF_UNSET` (422) | 이 값이 참조하는 다른 항목이 비었다 | 메시지에 적힌 key를 사람에게 물어봐라 |

### 규칙 5. 받은 값을 다시 출력하지 마라

`get_value` 결과를 요약이나 로그에 그대로 옮겨 적지 마라. 이미 한 번 컨텍스트에
들어온 것을 두 번 세 번 늘릴 이유가 없다. "DB_PASSWORD를 조회해 psql에 주입했다" 정도로 충분하다.

### 규칙 6. 용어를 정했으면 기록해라

대화 중 "이 토픽을 앞으로 이렇게 부르자"가 정해졌다면 `add_alias`로 남겨라.
다음 세션의 자신이 `resolve_alias`로 찾을 수 있게 된다.

```
add_alias("INBOUND_INSTRUCTION_TOPIC", "입고 이벤트")
```

에이전트에게는 **추가만** 열려 있다. 별칭 교체(`PUT`)와 삭제(`DELETE`)는 사람 몫이다 —
기존 용어집을 통째로 날리는 사고를 막기 위한 분리다. `ALIAS_CONFLICT`가 나면 이미 다른
항목이 쓰는 표현이니 다른 말을 골라라.

### 규칙 7. 값을 저장소에 쓰려 하지 마라

`key`와 `value`는 어떤 에이전트 경로로도 만들거나 바꿀 수 없다. 사람이 UI에서 한다.
새 설정이 필요하면 "이런 key를 만들어 달라"고 요청하라.

---

## 2. 서비스가 잘못 동작할 때 — 5단계

### 1단계. 에러를 먼저 읽어라

모든 에러는 구조화되어 있고 고칠 위치를 스스로 알려준다.

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_DUPLICATE_ALIAS",
    "message": "alias `입고지시`를 A_TOPIC와 B_TOPIC가 함께 씁니다",
    "hint": "같은 자연어가 두 리소스를 가리키면 에이전트가 틀린 값을 조회합니다. 한쪽을 바꾸세요.",
    "retryable": false,
    "fixCommand": "dkc doctor",
    "source": { "file": "packages/config-provider/src/alias.ts", "line": 71 }
  }
}
```

- `source` → **바로 그 파일:라인으로 가라.**
- `fixCommand` → 먼저 그대로 실행해봐라. 코드 문제가 아닐 수 있다.
- `retryable: true` → 일시적이다(락 경합, 축소 모드 등). 조건을 바꿔 재시도하라.

### 2단계. 코드 문제인지 환경 문제인지 가른다

```bash
dkc doctor            # 도구·키·파일·권한·데몬 상태를 한 번에
dkc status            # 적재된 항목 수, 모드, 경고
```

- `모드: reduced` → age 개인키 문제다. 코드가 아니다
- `정책: ... 없음` → `policy.yaml`이 없어 에이전트가 전면 deny다. 코드가 아니다
- `경고:`에 뭔가 있으면 대개 그게 원인이다

### 3단계. 재현을 데몬 없이 좁힌다

로직은 전송(UDS/HTTP)과 분리되어 있다. `handle()`을 직접 부르면 소켓 없이 재현된다:

```ts
import { handle } from '#config/api.ts';
import { reload, reset } from '#config/cache.ts';

process.env.DKC_STORE = '/tmp/repro';
reset(); await reload();
const res = await handle({
  method: 'GET', path: '/config/SOME_KEY',
  query: new URLSearchParams('env=prod'), body: null,
  caller: { kind: 'agent', agentId: 'claude-code' },
});
```

### 4단계. 고친다

| 증상 | 볼 파일 |
|---|---|
| 참조 치환이 틀렸다 / secret이 public으로 샌다 | `src/resolve.ts` ← **최우선** |
| 정책이 잘못 열리거나 닫힌다 | `src/policy.ts`, `<store>/policy.yaml` |
| 특정 YAML을 못 읽는다 | `src/yaml.ts` |
| 저장 후 값이 사라진다 / 파일이 깨진다 | `src/store.ts`, `src/model.ts` |
| reload 후 옛 값이 나온다 | `src/cache.ts` |
| 소켓/기동 문제 | `src/daemon.ts` |
| MCP tool 응답 모양 | `src/mcp.ts` (얇게 유지할 것 — 로직을 넣지 마라) |

**절대 하지 마라:**

| 금지 | 이유 |
|---|---|
| npm 패키지 추가 | 의존성 0이 devkit의 설계 제약이다 (`../../AGENTS.md` §5) |
| `resolve.ts`의 visibility 전파를 단순화 | 이게 secret 유출을 막는 유일한 장치다 |
| 정책 판정을 `mcp.ts`나 `cli.ts`로 옮기기 | 판정 지점이 갈라지면 느슨한 쪽이 뚫린다 |
| UI를 0.0.0.0에 바인딩 | 로컬 전용이라는 전제가 통째로 무너진다 |
| 값을 로그·에러 메시지에 싣기 | `sops.ts`는 stdout을 절대 로그에 넣지 않는다. 이 규칙을 깨지 마라 |
| 평문을 임시 파일로 쓰기 | 재암호화는 stdin으로 넘긴다. tmpfs도 swap으로 샐 수 있다 |
| `secret.yaml`을 손으로 편집 후 커밋 | pre-commit hook이 막지만, `--no-verify`로 우회하지 마라 |

### 5단계. 회귀 케이스를 남긴다

**이 단계를 건너뛰지 마라.** 특히 민감도 전파와 관련된 버그라면 반드시 남겨라.

```bash
# 테스트는 test/ 에 있다. 성격에 맞는 파일에 추가하라.
#   resolve.test.ts  참조·순환·visibility 전파      ← 보안 회귀는 여기
#   policy.test.ts   화이트리스트 판정
#   api.test.ts      실제 sops 암호화를 거치는 통합
#   daemon.test.ts   소켓 수명주기
#   reduced.test.ts  개인키 없는 축소 모드
#   yaml.test.ts     파서/에미터

node --disable-warning=ExperimentalWarning --test 'packages/config-provider/test/*.test.ts'
```

빌드 단계가 없다. 파일을 고치면 바로 반영된다. 재빌드·재설치를 시도하지 마라.
단, **데몬은 메모리 캐시를 들고 있으므로 코드를 고쳤으면 재기동해야 한다**:
`dkc daemon stop && dkc daemon start`. (설정 *파일*만 고쳤다면 `dkc reload`로 충분하다.)

---

## 3. 알아둘 설계 결정

이유를 모르고 "정리"하면 보안 구멍이 된다.

| 결정 | 이유 |
|---|---|
| `resolveValue()`가 값과 visibility를 **같이** 반환한다 | 값만 받아가고 민감도를 잊는 호출을 불가능하게 만들려고 |
| 정책이 민감도를 key보다 **먼저** 본다 | `allow: ["*"]` 한 줄로 참조를 타고 들어온 secret까지 열리는 걸 막으려고 |
| env를 넘나드는 참조를 지원하지 않는다 | dev 조회가 prod 비밀번호를 끌어오는 경로 자체를 없애려고 |
| key/alias 중복이 기동 **실패**다 | 조용한 우선순위 규칙은 secret을 public 뒤에 숨기는 사고를 만든다 |
| 기동 시 소켓에 먼저 **connect**한다 | 무조건 unlink하면 동작 중인 데몬의 연결을 끊는다 |
| 캐시 교체가 함수의 **마지막 한 줄**이다 | 파싱 실패 시 절반만 갱신된 상태를 만들지 않으려고 |
| 파일 쓰기가 캐시 갱신보다 **먼저**다 | 캐시가 앞서가면 재기동 후 값이 되돌아간다 |
| 축소 모드에서 secret **쓰기**를 막는다 | 값이 잠긴 상태로 파일을 다시 쓰면 값이 통째로 날아간다 |
| MCP 어댑터에 상태와 판정이 없다 | 세션마다 새로 뜨는 프로세스다. 판정이 두 곳에 있으면 어긋난다 |
