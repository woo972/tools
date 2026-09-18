# config-provider — 개인용 설정 저장소

서버 주소, 비밀번호, API 키, 도메인 용어(카프카 토픽명 등)를 한 저장소에서 관리하고,
**본인은 UI로 원본 평문을 바로 확인하되 AI 에이전트에게는 최소한만 노출**하는 로컬 서비스.

- 값을 몰라도 되지만 이름을 기억 못 하는 리소스를 자연어로 찾는다 — "입고지시" → `INBOUND_INSTRUCTION_TOPIC`
- 민감값은 sops + age로 암호화해 git에 올린다. 복호화는 데몬 기동 시 **1회**뿐이라 조회가 빠르다
- 에이전트는 `resolve_alias`(값 없음) → `get_value`(정책 게이트) 2단계로만 값에 닿는다

> **먼저 [§9 보장하는 것과 보장하지 않는 것](#9-보장하는-것과-보장하지-않는-것)을 읽어라.**
> 요약하면: 실수와 우연한 유출은 막지만, **셸을 쓸 수 있는 에이전트를 막는 경계는 아니다.**
> 그 둘을 구분하지 않으면 이 도구를 잘못 믿게 된다.

에이전트용 문서는 [AGENTS.md](AGENTS.md)에 따로 있다.

---

## 0. 3분 설치

```bash
brew install sops age                                  # 1. 도구
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt              # 2. age 키 (출력된 public key를 메모)
chmod 600 ~/.config/sops/age/keys.txt

cd /path/to/devkit
./bin/dkc init                                         # 3. 저장소 생성
./bin/dkc install-hook                                 # 4. 평문 커밋 차단
./bin/dkc doctor                                       # 5. 남은 문제 확인

./bin/dkc daemon start                                 # 6. 데몬 기동
./bin/dkc ui                                           # 7. 브라우저에서 값 채우기
```

`dkc`를 PATH에 두려면 `ln -s "$PWD/bin/dkc" /usr/local/bin/dkc`.

**먼저 백업하라.** `~/.config/sops/age/keys.txt`를 잃으면 암호화된 값은 **영구히 복구 불가**다
(사양상 마스터키가 없다). 아래 §6을 지금 읽어라.

---

## 1. 전체 구조

```
[age 개인키] ──▶ sops -d (기동 시 1회) ──▶ [메모리 캐시]
                                              │
                                Unix Domain Socket (0600)
                                              │
      ┌───────────────────────┬───────────┴───────────┬───────────────────────┐
   MCP 어댑터              Local UI                 dkc CLI              Raycast 확장
(Claude Code/Codex)   (127.0.0.1 전용)          (쉘/스크립트)         (⌘Space → config)
```

모든 진입점이 데몬 하나만 거친다. 파일이나 age 키에 직접 접근하는 경로를 두지 않아
정책 적용 지점이 한 곳으로 모인다.

| 파일 | 내용 | 암호화 |
|---|---|---|
| `<store>/config/public.yaml` | 서버 주소, 토픽명 등 | 없음 (평문 git 관리) |
| `<store>/config/secret.yaml` | 비밀번호, API 키 | `value` 필드만 sops+age |
| `<store>/collections.yaml` | 키를 묶는 컬렉션 (UI 좌측 패널) | 없음 (key 이름만) |
| `<store>/.sops.yaml` | 암호화 규칙 (recipient) | — |
| `<store>/policy.yaml` | 에이전트 화이트리스트 | — |
| `~/.config/sops/age/keys.txt` | age 개인키 | **git에 절대 넣지 않음** |

`<store>` 기본값은 `~/.config/config-provider` (`DKC_STORE`로 변경).

---

## 2. 항목 추가하기

### UI로 (권장)

`dkc ui` → `http://config-provider.localhost:7777` → `새 항목` → key·저장 위치(public/secret)·컬렉션·종류·별칭·설명을 고르고 env별
초기 값까지 한 번에 입력. 값은 오른쪽 표에서 클릭해 그 자리에서 다시 편집한다.

### 파일로

`public.yaml`을 직접 열어 편집한 뒤 `dkc reload`. 형식:

```yaml
items:
  - key: "INBOUND_INSTRUCTION_TOPIC"    # 두 파일 전체에서 유일해야 한다
    resource_type: "topic"              # 등록된 종류 중 하나 (아래 표)
    alias: ["입고지시", "입고 지시"]      # 자연어 검색어. 항목 간 중복 불가
    value:
      prod: "moms.inbound.instruction.v1"
      dev: "moms.inbound.instruction.v1.dev"
    desc: "입고 지시 이벤트 발행 토픽"
    ref: "https://wiki.internal/..."
```

`secret.yaml`은 암호문 상태이므로 직접 편집하려면 `sops <store>/config/secret.yaml`
(에디터가 뜨고, 저장하면 자동 재암호화된다).

**`resource_type`은 등록된 목록에서 고른다.** 자유 입력을 두면 같은 것을 `api_key`·
`api-key`·`apikey`로 적게 되고, 그 순간 종류로 묶어보는 일이 불가능해진다.

| 값 | 뜻 | 값 | 뜻 |
|---|---|---|---|
| `endpoint` | 엔드포인트·호스트 | `bucket` | 버킷·스토리지 |
| `database` | 데이터베이스 | `webhook` | 웹훅 |
| `password` | 비밀번호 | `feature_flag` | 기능 플래그 |
| `api_key` | API 키·토큰 | `account` | 계정·사용자명 |
| `oauth` | OAuth 클라이언트 | `topic` | 토픽·큐 |
| `certificate` | 인증서·개인키 | `other` | 기타 |

UI와 API는 이 목록 밖의 값을 거부한다. 다만 **파일에 이미 들어 있는 목록 밖의 값은
기동을 막지 않는다** — 저장소의 진실은 파일이고, 값을 못 보게 만드는 건 과한 대가다.
UI는 그런 값을 '등록 외'로 표시해 그대로 유지한다. 목록을 늘리려면 `src/model.ts`의
`RESOURCE_TYPES`에 추가한다.

예시 파일은 [`examples/`](examples/)에 있다.

### 값 조합 — 참조 문법

```yaml
  - key: "ORDER_DB_URL"
    value:
      prod: "postgres://orders:{{DB_PASSWORD}}@{{ORDER_SERVICE_HOST}}:5432/orders"
```

- 참조는 조회 시점에 치환되고, 파일에는 템플릿이 그대로 남는다
- **같은 env 안에서만** 해석된다. `env=dev` 조회가 prod 비밀번호를 끌어올 수 없다
- **secret을 참조하면 결과물도 secret이다.** 위 항목은 `public.yaml`에 있어도 실효
  visibility가 secret이라 에이전트에게는 기본적으로 거부된다
- 리터럴 중괄호는 `{{{{`
- 순환 참조는 데몬 기동을 실패시킨다. 깊이 상한은 5단계

### 미설정 값

```yaml
    value:
      prod: null          # 정의는 있으나 값이 아직 없음
      dev: "sk-dev-xxxx"
```

`null`은 "값 미설정"이고 항목 자체가 없는 것과 다르다. 조회하면 404가 아니라
`200 + status: "unset"`이 온다. 덕분에 에이전트가 "사람에게 물어봐야 한다"와
"key 이름을 잘못 알았다"를 구별한다. 빈 문자열 `""`은 "의도적으로 빈 값"으로 별개다.

---

## 3. 쓰기

### 조회

```bash
dkc resolve 입고지시                       # 자연어 → key (값은 안 나온다)
dkc get INBOUND_INSTRUCTION_TOPIC          # env 생략 시 dev
dkc get INBOUND_INSTRUCTION_TOPIC --env prod
dkc get ORDER_DB_URL --raw                 # 참조를 치환하지 않은 템플릿
```

`dkc get`은 값만 출력하므로 명령 치환에 바로 쓴다. 종료 코드로 상태를 구분한다:
`0` 성공, `3` 값 미설정, `1` 그 외 에러.

### 값을 셸에 남기지 않고 쓰기 (권장)

```bash
dkc exec --with PGPASSWORD=DB_PASSWORD --env prod -- psql -h db.internal -U orders
```

값이 자식 프로세스의 환경변수로만 들어간다. 셸 히스토리·스크롤백·터미널 로그
어디에도 평문이 남지 않는다. **에이전트에게 명령을 시킬 때도 이 형태를 쓰게 하라** —
값이 대화 컨텍스트에 들어오지 않는다.

### zshrc 연동

```bash
# ~/.zshrc
export PATH="$HOME/IdeaProjects/devkit/bin:$PATH"

# 필요한 시점에만 꺼내 쓴다. 상시 export는 민감도 낮은 값에만.
alias psql-orders='dkc exec --with PGPASSWORD=DB_PASSWORD --env prod -- psql -h "$(dkc get ORDER_SERVICE_HOST --env prod)" -U orders'

cfg() { dkc resolve "$*"; }
```

값을 셸에 직접 타이핑하지 말고 항상 명령 치환으로 처리하라.

### 편집

```bash
dkc set NEW_SERVICE_API_KEY --env prod --value "sk-..."
dkc set NEW_SERVICE_API_KEY --env prod --unset     # null(미설정)로 되돌리기
dkc alias add INBOUND_INSTRUCTION_TOPIC "입고 이벤트"
dkc alias rm  INBOUND_INSTRUCTION_TOPIC "입고 이벤트"
```

값 변경은 소유자(UI/CLI) 전용이다. 에이전트에게는 열리지 않는다.

---

## 4. UI

```bash
dkc ui          # http://config-provider.localhost:7777
```

화면은 세 덩어리다: 얇은 상단 바 · 좌측 컬렉션 탐색기 · 우측 상세.
**값은 예외 없이 표로 그린다** — 오른쪽의 값·참조·메타·별칭·CLI가 모두 표다.

- **좌측**: 위쪽에 검색(key·별칭·설명을 한 번에), 아래에 컬렉션 트리. 컬렉션은 접히고,
  키를 끌어다 다른 컬렉션에 넣을 수 있다. 어디에도 없는 키는 '미분류'에 모인다
- **우측**: 고른 키의 상세. **표의 값을 클릭하면 그 자리에서 편집된다**
  (Enter 저장 · Esc 취소). 값·종류·설명·참고·별칭·소속 컬렉션이 모두 여기서 바뀐다
- **상단**: 숫자마다 뜻을 라벨로 붙인 카드 다섯 장 — 저장된 항목 / 손볼 항목(미설정·문제) /
  환경(기본 env 강조) / 비밀값 읽기 가능 여부 / 마지막 읽기 시각. 오른쪽은 README·전체 보기·
  .env 복사·reload·새 항목. `README` 버튼으로 사용법과 구조를 화면 안에서 본다

- secret 항목이라도 **복호화된 원본 평문을 그대로** 보여준다. 해시나 부분 마스킹이 아니다
- 기본 표시는 마스킹(●●●●)이지만 **눈 아이콘 한 번에 즉시 전체가 드러난다.**
  어깨너머 노출을 줄이려는 것이지 값을 감추려는 게 아니므로 재인증을 요구하지 않는다.
  `전체 보기`는 15초 뒤 자동으로 다시 가리고, 항목별 토글은 끌 때까지 유지된다
- prod / dev / stg를 한 표에서 나란히 본다. 아직 정의되지 않은 env도 값을 넣으면 생긴다
- 참조 항목은 인스펙터에서 템플릿 원본·치환 결과·참조 key를 함께 본다.
  참조 key를 누르면 그 항목으로 이동한다. **편집은 항상 템플릿 기준이다**
- "복사" 후 30초 뒤 클립보드를 자동으로 비운다. 여러 항목을 골라 `.env` 형식으로도 복사된다
  (파일로 내려받지 않는다 — 평문이 디스크에 남으면 저장 경계가 무의미해진다)
- 미설정(null) · 잠김(축소 모드) · 치환 실패는 각각 다른 상태로 표시된다
- 상세의 표는 2열로 놓인다. 한 줄에 담기는 글자가 줄어 눈이 덜 움직인다 (좁은 화면에선 1열)
- `/`로 검색에 바로 간다. 검색 중에는 접어둔 컬렉션도 결과를 보여준다
- 외부 폰트·아이콘 CDN을 쓰지 않는다. 평문을 그리는 페이지라 나가는 요청 경로를 만들지 않는다

### 컬렉션

키를 묶는 폴더다. `<store>/collections.yaml`에 **key 이름만** 저장된다.

```yaml
collections:
  - name: "주문 도메인"
    keys:
      - ORDER_DB_HOST
      - ORDER_DB_URL
```

- 한 key는 최대 한 컬렉션에 속한다. 끌어다 놓으면 원래 자리에서 빠진다
- **컬렉션을 지워도 key는 지워지지 않는다.** 미분류로 돌아갈 뿐이다
- 값이 들어있지 않으므로 그대로 git에 커밋해도 되고, **축소 모드에서도 편집된다**
  (secret 재암호화 경로를 타지 않는다)
- 항목 파일(public/secret)을 건드리지 않는다. 정리 정보가 설정 스키마에 섞이지 않는다
- 컬렉션 편집은 소유자 전용이다. 에이전트에게는 열리지 않는다

**127.0.0.1에만 바인딩된다.** 브라우저에서는 고정 주소 `http://config-provider.localhost:7777`로
접속한다. `.localhost`는 loopback 전용 이름이므로 별도 DNS나 `/etc/hosts` 설정이 필요 없다.
외부 인터페이스로 열 수 있는 옵션을 일부러 두지 않았다 —
노출되는 순간 이 설계의 전제(로컬 단일 머신)가 무너진다.

---

### Raycast에서 꺼내 쓰기

`⌘Space` → `config` → 검색어. 관련 키 목록이 뜨고, 고르면 값이 클립보드에 담긴다.

```bash
cd apps/config-provider/raycast
npm install && npm run dev     # 한 번 실행하면 Raycast에 등록된다
```

- 목록에는 **값이 실려오지 않는다.** 검색은 `/alias/search`(메타데이터 전용)를 쓰고,
  값은 고른 항목 하나에 대해 그 순간에만 가져온다 (§4.3의 2단계 조회 흐름 그대로)
- 복사는 `concealed`로 해서 **Raycast 클립보드 기록에 비밀값이 남지 않는다.**
  `⌘⇧V`는 클립보드를 아예 거치지 않고 앞 창에 바로 붙여넣는다
- `↵`는 기본 env(dev), `⌘⏎`로 다른 env를 고른다. prod를 기본으로 두지 않는 편이 안전하다
- 커맨드를 연 뒤에는 **글자마다 목록이 갱신된다.** 다만 Raycast 루트 검색창에 확장 결과를
  실시간으로 그리는 API는 없다 — 핫키나 별칭을 걸어 여는 동작 자체를 한 번으로 줄인다
- 데몬에는 소유자 자격으로 붙는다. UI·CLI와 같은 등급이며 에이전트 화이트리스트의 대상이 아니다

이 확장만 `@raycast/api`와 빌드 단계가 필요하다. 본체(의존성 0 · 빌드 없음)와 섞이지 않게
`raycast/`에 자체 `package.json`을 두고 분리했다. 자세한 내용은
[`raycast/README.md`](raycast/README.md).

---

## 5. 상시 기동

데몬은 조회의 유일한 경로이므로 상시 떠 있어야 한다.

### macOS (launchd)

```bash
sed -e "s#__DEVKIT__#$PWD#g" -e "s#__HOME__#$HOME#g" \
  apps/config-provider/service/dev.devkit.config-provider.plist \
  > ~/Library/LaunchAgents/dev.devkit.config-provider.plist
sed -e "s#__DEVKIT__#$PWD#g" -e "s#__HOME__#$HOME#g" \
  apps/config-provider/service/dev.devkit.config-provider-ui.plist \
  > ~/Library/LaunchAgents/dev.devkit.config-provider-ui.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.devkit.config-provider.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.devkit.config-provider-ui.plist
launchctl print gui/$(id -u)/dev.devkit.config-provider
launchctl print gui/$(id -u)/dev.devkit.config-provider-ui
```

설정 데몬과 UI가 각각 로그인할 때 시작된다. UI는 `127.0.0.1:7777`에서만 수신하며,
브라우저에서는 항상 `http://config-provider.localhost:7777`로 접근한다.

### Linux (systemd user, 소켓 활성화)

```bash
mkdir -p ~/.config/systemd/user
cp apps/config-provider/service/config-provider.{socket,service} ~/.config/systemd/user/
# .service의 ExecStart 경로를 체크아웃 위치에 맞게 고칠 것
systemctl --user daemon-reload
systemctl --user enable --now config-provider.socket
```

소켓 활성화를 쓰면 소켓의 생성·권한·정리를 systemd가 맡고 첫 요청 시 자동 기동된다.

### 소켓이 남았을 때

프로세스가 SIGKILL로 죽으면 소켓 파일이 남는다. 데몬은 기동할 때 **먼저 connect를
시도해** 살아있는 데몬이면 중복 실행으로 보고 멈추고, 연결이 거부되면 stale로 보고
지운다. 수동으로 소켓 파일을 지우지 마라 — 동작 중인 데몬의 연결을 끊을 수 있다.

---

## 6. age 키 — 백업과 분실 대응

### 백업 (지금 하라)

개인키를 잃으면 복구 방법이 없다. **recipient를 2개 이상 등록해 두는 것이 유일한 보험이다.**

```bash
# 1. 백업 키를 하나 더 만든다 (다른 머신이나 오프라인 매체에 보관)
age-keygen -o ~/backup-age-key.txt

# 2. .sops.yaml에 두 public key를 모두 넣는다
#    creation_rules:
#      - path_regex: config/secret\.yaml$
#        encrypted_regex: '^value$'
#        age: >-
#          age1주키...,
#          age1백업키...

# 3. 기존 파일을 새 recipient 목록으로 다시 봉인한다
cd "$DKC_STORE" && sops updatekeys config/secret.yaml

# 4. 백업 키를 이 머신에서 치우고 물리적으로 보관한다
#    (인쇄, 하드웨어 토큰, 다른 머신의 암호화 볼륨 등)
```

`dkc doctor`가 recipient가 1개면 경고한다.

### 개인키를 잃었다면

1. 백업 키가 있으면: `SOPS_AGE_KEY_FILE=/path/to/backup age-key 로 데몬 재기동` → 새 주키를
   만들어 `.sops.yaml`에 추가 → `sops updatekeys`
2. 백업 키가 없으면: **복구 불가다.** 암호화된 값은 버리고 각 시스템에서 자격증명을
   재발급받아야 한다. 이때 `secret.yaml`의 key/alias/desc/ref는 평문이므로
   **"무엇을 재발급해야 하는지 목록"은 그대로 남아 있다** — 그 목록을 보고 하나씩 채워라

### 키가 없는 동안 (축소 모드)

개인키 없이 기동하면 데몬은 죽지 않고 **축소 모드**로 뜬다.

| 동작 | 축소 모드 |
|---|---|
| public 항목 조회·편집 | 정상 |
| secret 항목 alias 검색 | 정상 (메타데이터가 평문이라 가능) |
| secret 값 조회 | `503 SECRET_UNAVAILABLE` |
| secret 항목 alias/값 편집 | `503` (sops가 MAC을 다시 계산하려면 개인키가 필요) |

---

## 7. AI 에이전트 연결

### Claude Code

```bash
claude mcp add config-provider --scope user -- /절대경로/devkit/bin/dkc-mcp
claude mcp list
```

`--scope user`를 쓴다. project 스코프는 `.mcp.json`이 팀 저장소에 커밋되어 개인 provider
경로가 공유되므로 쓰지 않는다.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.config-provider]
command = "/절대경로/devkit/bin/dkc-mcp"
args = []
startup_timeout_sec = 10
default_tools_approval_mode = "writes"   # add_alias(쓰기)에 사람 승인이 걸린다
```

또는 `codex mcp add config-provider -- /절대경로/devkit/bin/dkc-mcp`.

### 무엇을 허용할지 — policy.yaml

기본 정책은 **deny**다. 정책 파일이 없으면 에이전트는 아무 값도 못 본다.

```yaml
agents:
  - id: "*"                 # 모두에게 적용되는 기준선
    allow: []
  - id: "claude-code"
    allow: ["*_TOPIC", "*_HOST", "*_ENDPOINT"]
    allow_secret: false     # 실효 visibility가 secret이면 allow에 있어도 거부
    alias_write: true       # alias 추가만. 교체·삭제는 사람 몫
```

판정은 **민감도를 key보다 먼저 본다.** `allow: ["*"]`를 켜도 `allow_secret: false`면
secret은 나가지 않는다. 참조를 통해 secret이 섞인 항목(`ORDER_DB_URL` → `DB_PASSWORD`)도
같은 취급을 받는다.

고친 뒤에는 `dkc reload`.

### 값을 주지 않는 편이 낫다

에이전트가 값 자체를 알 필요 없이 명령만 실행하면 되는 경우, 값을 주는 대신
`dkc exec`를 쓰게 하라. MCP로 값을 한 번 내보내면 그 값은 에이전트의 컨텍스트·로그·
전송 경로에 남는다.

다만 `exec`가 막아주는 것을 과대평가하지 마라. **협조적인 에이전트에만 유효하다.**

```bash
dkc exec --with PW=DB_PASSWORD -- printenv PW   # 값이 그대로 stdout → 컨텍스트
```

`exec`는 값이 새는 경로를 닫는 장치가 아니라, 새지 않는 쪽이 기본이 되게 하는 장치다.
무엇이 실제로 막히고 무엇이 안 막히는지는 §9를 읽어라.

---

## 8. 문제 해결

먼저 `dkc doctor`. 대부분의 문제에 대해 고칠 명령을 같이 알려준다.

| 증상 | 원인과 조치 |
|---|---|
| `DAEMON_UNAVAILABLE` | 데몬이 없다 → `dkc daemon start`. 소켓 경로가 다르면 `DKC_SOCKET` 확인 |
| `DAEMON_ALREADY_RUNNING` | 이미 떠 있다. 기존 것을 쓰거나 `dkc daemon stop` 후 재시작 |
| `SECRET_UNAVAILABLE` | 축소 모드다 → 개인키를 두고 `dkc reload` (§6) |
| `CONFIG_DUPLICATE_KEY` | 두 파일에 같은 key가 있다. 조용한 우선순위를 두지 않으므로 기동이 실패한다. 한쪽을 지워라 |
| `CONFIG_DUPLICATE_ALIAS` | 두 항목이 같은 별칭을 쓴다. 에이전트가 틀린 값을 조회하게 되므로 기동이 실패한다 |
| `CONFIG_REFERENCE_CYCLE` | `A → B → A` 형태의 참조. 한쪽을 상수로 풀어라 |
| `REF_UNSET` | 참조 대상의 값이 아직 없다. 메시지에 어느 key인지 적혀 있다 |
| `VERSION_CONFLICT` | 조회 이후 다른 곳에서 고쳤다. 다시 조회해 최신 상태로 편집하라 |
| `ALIAS_CONFLICT` | 별칭 중복. 응답의 `details.conflictKey`가 충돌 대상이다 |
| `POLICY_DENIED` | 정책이다. 우회하지 말고 `policy.yaml`을 고쳐라 |
| `SOPS_RULES_MISSING` | `.sops.yaml`이 없다 → `dkc init` |
| 데몬 로그를 보고 싶다 | `dkc daemon run` (포그라운드). 로그에는 key와 결과 코드만 남고 값은 남지 않는다 |

---

## 9. 보장하는 것과 보장하지 않는 것

이 절이 이 도구의 위협 모델이다. **쓸지 말지를 여기서 판단하라.**

### 9.1 보장한다

| 보장 | 근거 |
|---|---|
| **평문이 디스크에 남지 않는다** | `secret.yaml`의 `value` 필드만 sops+age로 봉인한다. 복호화 결과는 메모리에만 있고, sops의 stdout(=평문)은 로그·에러 메시지에 절대 싣지 않으며 임시 파일도 쓰지 않는다 (`src/sops.ts`) |
| **진입점이 하나다** | UI·MCP·CLI가 모두 UDS 데몬 하나를 거친다. 파일이나 age 키에 직접 닿는 경로를 두지 않아 정책 적용 지점이 한 곳으로 모인다 (`src/api.ts`) |
| **밖으로 나가는 경로가 없다** | UI는 `127.0.0.1`에만 바인딩하고 호출 인자로도 바꿀 수 없다. 페이지 CSP는 `default-src 'none'`이고 폰트·아이콘 CDN조차 쓰지 않는다. 텔레메트리 없음 |
| **로그에 값이 없다** | 데몬 로그는 `method path status code`만 남긴다 |
| **참조로 섞인 민감도를 놓치지 않는다** | `{{ }}` 참조로 secret이 딸려온 항목은 선언이 public이어도 **실효 secret**으로 판정된다. 정책은 민감도를 key보다 먼저 본다 (`src/resolve.ts`, `src/policy.ts`) |
| **깜빡한 상태가 안전한 상태다** | `policy.yaml`이 없으면 에이전트 전면 deny. 정책 파싱 실패는 조용한 deny 대신 명시적 기동 실패로 떨어진다 |
| **조용한 오동작이 없다** | 중복 key·중복 alias·참조 순환은 기동을 실패시킨다. 개인키가 없으면 축소 모드로 내려가고 그 사실을 UI·`status`·`doctor`가 모두 말한다 |
| **쓰기 사고를 막는다** | 낙관적 잠금(version)으로 충돌을 감지한다. 에이전트는 값을 바꿀 수 없고 alias 추가만 가능하다 |
| **평문 커밋을 막는다** | `dkc install-hook`의 pre-commit |

### 9.2 보장하지 않는다

**1. 에이전트로부터의 격리 — 가장 중요한 항목이다.**

`x-dkc-caller` 헤더는 인증이 아니다. 소켓에 닿을 수 있는 프로세스는 어떤 헤더든 보낼 수 있다.

```bash
# 셸을 쓸 수 있는 에이전트는 정책을 이렇게 우회한다
curl --unix-socket "$TMPDIR/config-provider/daemon.sock" \
     -H 'x-dkc-caller: owner' 'http://x/config/DB_PASSWORD?env=prod'

# 애초에 age 키를 직접 읽어도 된다 — 데몬을 거칠 이유가 없다
sops -d ~/.config/config-provider/config/secret.yaml
```

`dkc get`과 `dkc exec`도 `owner`로 요청하므로 `policy.yaml`을 타지 않는다.
**정책이 실제로 걸리는 경로는 MCP 어댑터 하나뿐이다.**

그래서 `policy.yaml`은 *침해된 에이전트를 막는 경계*가 아니라
*실수와 컨텍스트 오염을 줄이는 장치*다. 이 구분을 받아들이고 써라.
진짜 경계가 필요하면 에이전트를 **별도 uid나 컨테이너**에서 돌리고 소켓을 그 그룹에만
노출해야 한다. 같은 uid 안에서는 어떤 헤더·토큰·프롬프트로도 경계가 생기지 않는다.

**2. 메모리에 상주하는 평문.** 데몬이 살아 있는 동안 복호화된 값이 프로세스 메모리에
있으므로 같은 유저 권한을 얻은 프로세스는 이를 읽을 수 있다. UDS 권한(0600)도 같은 전제
위에 있다. **디스크 전체 암호화(FileVault/LUKS)를 병행한다고 가정한 설계다.**

**3. 감사.** key와 결과 코드는 로그에 남지만, "어떤 에이전트가 어떤 secret을 언제 읽었나"를
보존하는 append-only 감사 로그는 **없다**. 실시간 차단이 불가능한 위협 모델에서 사후 추적도
없다는 뜻이다.

**4. `dkc exec`의 방어 범위.** env 주입은 셸 히스토리·스크롤백·파일에 값을 남기지 않고,
macOS에서는 다른 프로세스의 환경변수가 `ps eww`로도 읽히지 않는다(이 머신에서 확인).
그래서 값을 출력해 복사·붙여넣기 하는 것보다 확실히 낫다. 그러나 **자식 프로세스가 값을
출력하면 그대로 샌다**(`dkc exec --with PW=K -- printenv PW`). Linux는 `/proc/<pid>/environ`
전제가 달라 같은 보장이 아니다.

**5. Keychain으로 바꿔도 1번은 풀리지 않는다.** macOS Keychain의 ACL은 "어느 **바이너리**가
요청했나"로 판정하므로, 에이전트도 같은 `/usr/bin/security`를 쓰는 한 프롬프트 없이 읽는다
(이 머신에서 확인). age 개인키를 Keychain으로 옮기는 선택은 *디스크의 평문 키 파일 제거 ·
화면 잠금 연동 · iCloud 백업*에 값이 있고, **에이전트 차단에는 값이 없다.**

**6. age 개인키를 잃으면 영구 복구 불가다.** 마스터키·백도어가 없는 것이 sops/age의 사양이다.
§6의 백업을 **지금** 하라.

**7. 팀 공유·원격 접근.** 로컬 단일 머신 기준이다. 여러 머신 동기화와 원격 접근은 범위 밖이다
(암호화된 파일의 git push/pull은 가능).

### 9.3 기능상의 한계

- alias 검색은 문자열 부분 매치 수준이다. 의미 기반(임베딩) 검색은 넣지 않았다
- 참조 문법은 단순 문자열 치환이다. 조건 분기나 함수 호출은 없다
- **파일을 다시 쓸 때 주석은 헤더만 보존된다.** UI나 `dkc alias`로 편집하면 항목 사이에
  적어둔 주석이 사라진다. 설명은 주석 대신 `desc` 필드에 적어라
- YAML은 서브셋만 읽는다. 앵커/별칭(`&`/`*`), 태그(`!!`), 멀티 문서(`---`)를 만나면
  조용히 무시하지 않고 명시적으로 실패한다

---

## 10. 개발

```bash
node --disable-warning=ExperimentalWarning --test 'apps/config-provider/test/*.test.ts'
```

의존성이 없고 빌드 단계도 없다. `.ts`를 Node 24가 직접 실행한다.
`sops`/`age`가 없으면 암호화 관련 테스트는 자동으로 skip된다.

| 파일 | 역할 |
|---|---|
| `src/resolve.ts` | **참조 치환 + 실효 visibility.** 가장 위험한 코드다. 여기부터 읽어라 |
| `src/api.ts` | 모든 surface가 통과하는 단일 지점. 라우팅·정책 게이트 |
| `src/policy.ts` | 화이트리스트. 민감도를 key보다 먼저 본다 |
| `src/cache.ts` | 메모리 캐시. reload 원자성 |
| `src/store.ts` | 파일 락 + 원자적 쓰기 |
| `src/sops.ts` | sops 호출을 독점한다. 평문은 여기 들어왔다 여기서만 나간다 |
| `src/yaml.ts` | YAML 서브셋 파서/에미터 (의존성 0 제약 때문에 직접 구현) |
| `src/collections.ts` | 컬렉션 파일. 값을 담지 않으므로 항목 파일과 완전히 분리돼 있다 |
| `raycast/` | Raycast 확장 (별도 npm 패키지). 본체의 의존성 0 제약과 분리돼 있다 |
| `src/daemon.ts` | UDS 서버 + stale 소켓 판별 |
| `src/mcp.ts` | MCP stdio 어댑터 (얇게 유지할 것) |
| `src/ui.ts` + `src/ui.html` | 로컬 UI |
| `src/cli.ts` | `dkc` 명령 |
