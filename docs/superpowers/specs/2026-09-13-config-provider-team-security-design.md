# Config Provider 팀 배포 최소 보안 설계

## 결정

Config Provider를 신뢰할 수 있는 개인 Mac에서 사용하는 개인 자격증명 도구로 배포한다.
모든 secret은 운영 자격증명일 수 있다고 가정하며, AI secret 조회는 기본 차단하고 UI의
cross-origin 쓰기를 서버에서 거부한다. 같은 OS 사용자 권한을 획득한 악성 프로세스는 이번
보안 경계 밖으로 명시한다.

AWS Secrets Manager 등 팀 공용 비밀 저장소를 대체하거나 동기화하지 않는다. 사용자가 공용
자격증명을 로컬로 복사하면 Config Provider는 이를 다른 secret과 동일하게 보호한다.

## 위협 모델

### 방어 대상

- 평문 secret 또는 age 개인키의 우발적 Git 커밋
- LAN 및 외부 인터페이스를 통한 UI 접근
- 다른 macOS 사용자 계정의 파일 및 소켓 접근
- 악성 웹페이지가 loopback UI에 보내는 cross-origin 요청
- 기본 설정이나 예제의 과도한 AI 권한
- 잘못된 파일 권한, 암호화 상태, LaunchAgent 설정의 배포 편차

### 비대상

- 같은 macOS 사용자로 실행되는 악성 프로그램 또는 브라우저 확장
- 사용자의 파일·셸 권한을 획득한 AI 에이전트의 의도적인 정책 우회
- 잠금 해제된 Mac이나 root 권한이 탈취된 상황

이 한계는 README와 진단 결과에 표시한다. 이를 방어하려면 별도 OS 계정, Keychain 사용자
승인 또는 프로세스 샌드박스가 필요하므로 최소 팀 배포 범위에 포함하지 않는다.

## 변경 설계

### 1. 안전한 기본 AI 정책

예제와 초기 생성 정책은 모든 agent에 대해 `allow: []`, `allow_secret: false`,
`alias_write: false`로 시작한다. 특정 agent 규칙을 자동으로 추가하지 않는다.

`doctor`는 wildcard secret 허용 또는 `allow: ["*"]`와 `allow_secret: true`의 결합을 높은
위험으로 보고 실패로 표시한다. 제한된 key의 secret 허용은 명시적 사용자 결정이므로 경고로
표시한다. MCP의 `get_value`는 유지하되 문서에서 `dkc exec`를 기본 사용법으로 안내한다.

### 2. UI cross-origin 방어

UI 서버는 `Host: config-provider.localhost[:7777]`만 허용한다. 브라우저 API 요청은 다음을
모두 만족해야 한다.

- `Origin`이 `http://config-provider.localhost:7777`과 정확히 일치한다.
- `Sec-Fetch-Site`가 있으면 `same-origin` 또는 `none`이다.
- 상태 변경 메서드는 `Content-Type: application/json`이다.
- 상태 변경 메서드는 세션 CSRF 토큰을 `X-DKC-CSRF-Token` 헤더로 보낸다.

UI 서버 시작 시 메모리에 임의 CSRF 토큰을 만들고 HTML 응답의 부트스트랩 메타 태그에 넣는다.
동일 출처 스크립트만 이를 읽어 API 요청 헤더에 보낸다. 토큰은 파일이나 로그에 쓰지 않고 UI
프로세스 재시작 시 폐기한다. GET/HEAD는 Origin이 없을 수 있지만 cross-site fetch는 거부한다.
API 응답에는 명시적으로 CORS 허용 헤더를 넣지 않는다.

고정 Host 검사는 DNS rebinding 방어이며 CSRF 토큰과 서로 다른 방어선이다. 서버는 계속
`127.0.0.1`에만 바인딩한다.

### 3. 설치 및 doctor 안전 점검

`doctor`에 다음 검사를 추가한다.

- store 및 config 디렉터리 0700
- secret, age 개인키, UDS 0600
- secret 파일의 sops 메타데이터와 암호문 존재
- age 개인키가 store 내부에 있지 않음
- 위험한 agent 정책 없음
- macOS UI LaunchAgent가 `127.0.0.1:7777` 구성과 일치
- FileVault 상태는 macOS에서 경고 수준으로 표시
- age recipient가 하나뿐인 경우 기존 경고 유지

자동 복구는 안전하게 권한을 좁힐 수 있는 항목에만 명시적 fix 명령을 제공한다. 기존 파일이나
정책을 자동 덮어쓰지 않는다.

### 4. 저장소 유출 방어

기존 pre-commit 검사를 유지하고 CI에 별도 검증을 추가한다. CI는 저장소 전체에서 age 개인키
패턴, secret 이름의 평문 파일, Config Provider 기본 정책의 wildcard secret 허용을 검사한다.
실제 사용자 secret이나 네트워크가 없어도 실행되는 결정적 스크립트로 구현한다.

범용 secret scanner 도입은 오탐 정책과 추가 의존성 검토가 필요하므로 이번 범위에서는 자체
고신뢰도 패턴 검사만 적용한다. 후속으로 gitleaks 같은 도구를 평가한다.

### 5. 감사와 관측

로그에는 값과 요청 본문을 남기지 않는다. daemon 로그에 caller kind, agent id, key, 결과 코드가
구조적으로 남도록 보강한다. UI의 Origin/CSRF 거부도 값 없이 사유와 함께 기록한다. 로그 회전과
대량 조회 탐지는 후속 범위로 둔다.

## 데이터 흐름

1. 사용자가 고정 UI 주소를 연다.
2. UI 서버는 정확한 Host로 HTML과 메모리 CSRF 토큰을 전달한다.
3. 동일 출처 UI 스크립트가 Origin, JSON Content-Type, CSRF 헤더와 함께 API를 호출한다.
4. UI 서버가 브라우저 경계를 검증한 뒤 owner 요청으로 UDS daemon에 프록시한다.
5. MCP는 별도 agent 호출자로 UDS daemon에 접근하며 기본 deny 정책을 적용받는다.
6. daemon은 값 없는 감사 메타데이터만 기록한다.

## 오류 처리

- Host 불일치: 403 `HOST_FORBIDDEN`
- Origin 또는 Fetch Metadata 불일치: 403 `CROSS_ORIGIN_FORBIDDEN`
- CSRF 토큰 누락·불일치: 403 `CSRF_INVALID`
- 상태 변경 요청의 Content-Type 불일치: 415 `CONTENT_TYPE_UNSUPPORTED`
- 위험 정책: daemon 실행은 유지하되 `doctor` 실패로 배포 준비 상태를 거부
- FileVault 미활성 또는 recipient 1개: 사용성을 막지 않는 경고

오류 응답에도 secret, 토큰, 요청 본문을 포함하지 않는다.

## 테스트

- 실제 HTTP 서버로 정확한 Host/Origin/CSRF 조합의 성공과 각 거부 분기를 검증한다.
- cross-origin `text/plain` 단순 POST가 daemon으로 전달되지 않는지 검증한다.
- 실제 listener 주소가 `127.0.0.1`인지 계속 검증한다.
- 기본 정책이 모든 agent secret을 거부하는지 검증한다.
- 위험 정책 조합과 파일 권한을 격리된 임시 store에서 doctor가 탐지하는지 검증한다.
- CI 보안 검사 스크립트를 안전/위험 fixture에 실행해 종료 코드를 검증한다.
- 전체 기존 테스트로 CLI, MCP, UI, 축소 모드 회귀를 확인한다.

## 트레이드오프와 후속 범위

- 고정 URL과 자동 시작의 편의성을 유지하는 대신 UI 공격면이 상시 열린다. Origin/CSRF 방어로
  웹 위협을 줄이지만 같은 사용자 권한의 프로세스는 막지 못한다.
- 기본 deny로 일부 기존 사용자는 정책을 직접 열어야 한다. 비밀의 묵시적 노출보다 명시적 설정
  비용을 선택한다.
- 메모리 캐시 성능을 유지하므로 secret은 daemon 수명 동안 평문 메모리에 남는다. Keychain 및
  사용자 승인 기반의 강한 격리는 별도 ADR로 다룬다.
- 팀 공용 secret의 로컬 복사를 기술적으로 막지 않는다. AWS Secrets Manager가 원본이라는 운영
  원칙과 경고를 제공하되, 로컬에 들어온 값은 동일한 고민감도로 처리한다.

## 배포 기준

다음 조건을 모두 만족해야 팀 배포 가능으로 판정한다.

- AI 기본 정책 deny 및 wildcard secret 정책 탐지
- UI Host, Origin, Fetch Metadata, JSON Content-Type, CSRF 검증
- loopback-only listener 회귀 테스트
- 파일·소켓 권한 및 암호화 상태 doctor 검사
- CI 고신뢰도 secret 검사
- 위협 모델과 한계 문서화
