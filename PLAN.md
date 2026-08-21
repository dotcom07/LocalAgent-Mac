# LocalAgent-Mac 구현 계획

## 1. 목표와 완료 조건

M4 Pro 24GB에서 아래 한 가지 구성을 재현 가능하게 설치하고, 장시간 단일 에이전트 세션이 안정적으로 도는지 검증한다.

```text
Pi
  -> localhost OpenAI/Anthropic API
oMLX stable
  -> Qwen3.8-27B MLX oQ4e-MTP
  -> Lightning MTP ON
  -> TurboQuant KV OFF
  -> context 16,384
  -> concurrent requests 1
  -> hot RAM + SSD prefix/KV cache
Apple MLX / Metal
```

완료 조건:

1. 새 Mac에서 문서 순서대로 설치와 설정을 재현할 수 있다.
2. 서버는 외부 인터페이스가 아니라 `localhost`에만 노출된다.
3. `/v1/models`, 일반 생성, thinking 생성, tool call을 순서대로 통과한다.
4. 16K를 API 상한으로 유지하고, 실제 prefill 안정 범위를 측정해 swap 폭증 없이 단일 에이전트 작업을 완료한다.
5. 같은 prefix를 반복했을 때 cache hit 또는 TTFT 개선을 측정 결과로 남긴다.
6. 실패하면 사용자가 설정을 되돌리거나 oMLX를 중지할 수 있다.

속도 목표인 `약 10 tok/s`는 합격 조건이 아니라 측정 항목이다. 실제 M4 Pro 24GB 결과로 기준을 확정한다.

## 2. 범위와 가정

- 대상은 Apple Silicon M4 Pro / 24GB / 현재 지원되는 macOS 한 대다.
- 첫 checkpoint는 `fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp`로 두고, 내려받기 전에 실제 존재 여부와 oMLX 호환성을 확인한다.
- 두 번째 checkpoint `scottlowry/Qwen3.8-27B-oQ4e-mtp`는 첫 모델이 사라졌거나 호환되지 않을 때만 사용한다.
- 확인한 최신 stable 기준은 oMLX `v0.6.2`다. `rc/dev` 버전은 실행 전에 거부한다.
- Pi는 deprecated된 `@mariozechner` 패키지 대신 호환 후속 패키지 `@earendil-works/pi-coding-agent`를 사용한다.
- 모델 다운로드는 용량과 시간이 크므로 자동 설치에 숨기지 않고 별도 명령으로 둔다.
- 저장소는 공개되어도 안전해야 한다. 토큰, 개인 경로, 캐시 파일, 모델 파일, 벤치 원본 prompt는 커밋하지 않는다.

첫 버전에서 하지 않을 일:

- oMLX와 Pi가 이미 제공하는 서버, 캐시, 에이전트 루프를 다시 구현하지 않는다.
- 웹 UI, 별도 백엔드, Python 패키지, Docker, 데이터베이스를 추가하지 않는다.
- `mlx-dspark`와 `llama.cpp`를 함께 설치하지 않는다. oMLX 기준선이 측정된 뒤 별도 단계로 비교한다.
- `iogpu.wired_limit_mb` 같은 시스템 전역 설정은 자동 변경하지 않는다.
- 24K/32K는 자동 승격하지 않는다. 16K 측정이 통과한 뒤 사용자가 명시적으로 시험한다.

## 3. 책임 경계와 불변식

```text
사용자
  | 명시적 install/download/start/bench
  v
local-agent (얇은 zsh 제어 스크립트)
  | 지원 여부 확인 + 공식 설정만 적용
  +----------------------+--------------------+
  v                      v                    v
Homebrew/oMLX            Pi                   macOS 도구
설치·서빙·캐시·보호      agent loop·compact    메모리/프로세스 측정
```

반드시 지킬 불변식:

- `context_tokens` 기본값은 `16384`다.
- `max_concurrent_requests`는 `1`이다.
- `lightning_mtp=true`, `turboquant_kv=false`로 시작한다.
- MTP와 TurboQuant를 동시에 켜는 코드는 첫 버전에 넣지 않는다.
- server ready 확인 전 Pi를 시작하지 않는다.
- 이미 설치된 도구와 사용자 설정을 덮어쓰지 않는다. 변경 전 현재값을 출력하고 백업한다.
- oMLX 버전이 요구 설정을 지원하지 않으면 조용히 무시하지 않고 실패한다.
- 모델과 캐시는 Git 저장소 밖의 oMLX 기본 위치에 둔다.
- 한 번에 하나의 모델만 pin/load한다.
- benchmark 실패는 설치 실패와 구분하고, 마지막 안정 설정은 16K로 유지한다.

## 4. 최종 코드 구조

첫 구현은 계획 문서를 포함해 일곱 파일이면 충분하다.

```text
LocalAgent-Mac/
├── PLAN.md                # 이 설계, 단계별 검증, Sol/Luna 작업 경계
├── README.md              # 복붙 가능한 설치·운영·복구 절차
├── local-agent            # 모든 제어 명령을 담은 macOS zsh 스크립트
├── local-agent.env.example# 사용자가 조정할 최소 설정과 기본값
├── measure.mjs            # SSE smoke test와 cold/warm 측정
├── test.sh                # config 보안, JSON 보존, 재실행 동일성을 확인하는 단일 테스트
└── .gitignore             # 개인 설정, 모델/cache, 측정 원본 제외
```

런타임 측정값은 `results/`에 만들되 `.gitignore` 대상으로 둔다. 측정 결과를 공유할 때만 개인정보를 제거한 요약 파일을 명시적으로 추가한다.

설정 파일의 최소 표면:

```sh
MODEL_ID=fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp
CONTEXT_TOKENS=16384
MEMORY_LIMIT_GB=20
REASONING_EFFORT=medium
```

host는 `127.0.0.1`로 고정한다. MTP, TurboQuant, concurrency도 안전 불변식이므로 첫 버전에서 사용자 설정으로 노출하지 않는다.

## 5. `local-agent` 함수 설계

스크립트는 `./local-agent <command>` 형태다. 함수는 아래 책임만 가진다.

| 함수 | 하는 일 | 입력 / 결과 | 지켜야 할 조건 |
| --- | --- | --- | --- |
| `usage` | 지원 명령과 예시를 출력한다. | 없음 / stdout | 상태를 바꾸지 않는다. |
| `die` | 한 줄 오류를 stderr에 쓰고 종료한다. | 메시지 / non-zero exit | 원래 실패 원인을 숨기지 않는다. |
| `load_config` | 기본값을 세운 뒤 선택한 env 파일을 읽고 값 형식을 검사한다. | env 파일 / 전역 설정 | 임의 shell code를 실행하지 않는 방식으로 읽는다. 알려진 key만 받고 context와 reasoning 값은 allowlist로 검증한다. |
| `check_config` | 설치나 상태 변경 없이 설정 파일만 검증한다. | env 파일 / 검증된 설정 요약 | 테스트와 사용자 사전 점검이 같은 경로를 쓴다. |
| `require_command` | 필요한 실행 파일 존재 여부를 확인한다. | 명령 이름 / 성공 또는 오류 | 설치를 몰래 수행하지 않는다. |
| `doctor` | Apple Silicon, 총 메모리, 여유 디스크, Homebrew, oMLX/Pi 버전과 포트 충돌을 읽기 전용 검사한다. | 현재 Mac / 표 형식 결과 | 검사 중 시스템을 변경하지 않는다. 24GB 미만이면 명확히 중단한다. |
| `install_tools` | 공식 Homebrew 방식으로 stable oMLX를, 공식 npm 후속 패키지로 Pi를 설치한다. | 사용자 실행 / 설치 결과 | 이미 설치됐으면 건너뛴다. `rc/dev`는 거부하고 curl-pipe-shell을 쓰지 않는다. |
| `download_model` | oMLX 서버를 띄우고 native Admin downloader를 연다. | `MODEL_ID` / 브라우저 downloader | 별도 downloader를 구현하지 않는다. partial download 처리는 oMLX가 소유한다. |
| `configure_omlx` | 서버를 중지한 뒤 기존 JSON을 보존하며 16K, 단일 요청, model pin, MTP, cache, memory limit을 원자적으로 적용한다. | 검증된 설정 / oMLX 설정 | 최초 기존 파일을 백업한다. 다른 모델은 설정을 보존하고 pin/default만 해제한다. |
| `start_server` | oMLX의 공식 background service를 시작하고 `wait_ready`를 호출한다. | 설정된 endpoint / ready server | 자체 daemon supervisor를 만들지 않는다. 중복 서버를 띄우지 않는다. |
| `wait_ready` | 제한 시간 동안 `/health`를 확인한다. | endpoint, timeout / 성공 또는 timeout | 무한 대기하지 않는다. timeout 시 공식 로그 위치를 알려준다. |
| `stop_server` | oMLX 공식 service stop을 호출한다. | 없음 / stopped | 다른 MLX·Python 프로세스를 이름으로 일괄 종료하지 않는다. |
| `status` | 설치 버전, server readiness, 발견된 모델을 읽기 전용으로 보여준다. | 현재 상태 / stdout | 전체 prompt나 비밀값을 출력하지 않는다. |
| `require_model_ready` | 서버를 시작하고 설정한 모델이 API에 보이는지 확인한다. | 설정된 model / ready model | 검증, benchmark, Pi가 같은 준비 조건을 쓴다. |
| `run_measure` | `measure.mjs`의 verify 또는 bench를 실행하고 timestamp 결과를 남긴다. | mode / summary JSON | prompt 원문은 저장하지 않고 실패 결과를 설치 실패와 구분한다. |
| `launch_pi` | `omlx launch pi`로 Pi 설정 백업·provider 연결·실행을 oMLX에 위임한다. | Pi 인자 / Pi 프로세스 | server/model ready 이후에만 실행한다. |
| `main` | 인자를 해석하고 정확히 한 command 함수로 전달한다. | CLI 인자 / 해당 exit code | 알 수 없는 명령은 usage와 함께 실패한다. |

`verify`와 `bench`는 확인된 oMLX SSE usage 형식만 읽는 `measure.mjs`에 연결한다. 별도 benchmark framework는 두지 않는다.

함수 호출 흐름:

```text
main
  -> usage
  -> check_config -> load_config
  -> doctor -> load_config
  -> install_tools
  -> download_model -> load_config
  -> configure_omlx -> load_config
  -> start -> load_config -> wait_ready
  -> launch_pi -> load_config -> start -> omlx launch pi
  -> status
  -> verify -> require_model_ready -> measure.mjs --verify
  -> bench -> require_model_ready -> measure.mjs --bench
  -> stop
```

`usage`, `status`, `stop`은 설정 파일을 요구하지 않는다. 특히 `stop`은 잘못된 설정을 복구하는 중에도 항상 실행 가능해야 한다.

`install`, `download-model`, `configure`를 한 개의 거대한 `setup` 명령으로 묶지 않는다. 큰 다운로드와 사용자 설정 변경이 분리되어야 재실행과 복구가 단순하다.

## 6. 단계별 구현 계획과 검증

### Phase 0 — 설치 버전의 실제 인터페이스 고정 (Sol, 완료)

1. 공식 oMLX stable과 Pi 버전을 확인한다.
2. CLI help, 공식 설정 파일/API, service 관리 방식, model download 방식을 확인한다.
3. Qwen checkpoint 존재 여부, MTP 감지, Qwen tool parser 지원을 확인한다.
4. 문서의 가정과 다른 항목만 설계에 반영한다.

검증: 문서에 쓰는 모든 명령이 `--help` 또는 공식 문서에서 확인되어야 한다. 추측한 flag는 코드에 넣지 않는다.

### Phase 1 — 안전한 제어 골격 (Sol, 완료)

1. `local-agent.env.example`과 config validation을 만든다.
2. `doctor`, `status`, `usage`를 먼저 구현한다.
3. `test.sh`에서 정상 설정, 잘못된 context, `HOST` 같은 미지원 key, 알 수 없는 command를 검사한다.

검증: 아무것도 설치하지 않은 Mac에서도 `doctor`가 상태를 바꾸지 않고 유용한 실패를 반환한다.

### Phase 2 — 설치·설정·수명주기 (Sol, 완료)

1. `install_tools`, `download_model`, `configure_omlx`, `launch_pi`를 공식 인터페이스에 얇게 연결한다.
2. `start`, `wait_ready`, `stop`을 oMLX service 관리에 연결한다.
3. 기존 설정 백업과 재실행 안전성을 확인한다.

검증: 같은 명령을 두 번 실행해도 중복 설치, 중복 프로세스, 설정 손상이 없어야 한다.

### Phase 3 — 기능 smoke test (Sol 자동화 완료, Luna 실측)

1. `/v1/models`와 짧은 completion을 확인한다.
2. thinking/medium 응답이 끝까지 완료되는지 확인한다.
3. 파일을 건드리지 않는 작은 tool call schema를 확인한다.
4. 같은 prefix 요청을 두 번 보내 TTFT 차이와 cache 상태를 기록한다.

검증: 네 단계가 직렬로 통과하고, 실패한 단계와 서버 로그 위치가 한 번에 보인다.

### Phase 4 — M4 Pro 24GB 실측과 보정 (Luna)

1. 16K 프로파일에서 cold/warm 각 3회 측정한다. 모델 guard가 허용하는 실제 prompt 길이는 calibration 결과로 기록한다.
2. peak RSS, macOS memory pressure, swap 변화, TTFT, decode tok/s를 기록한다.
3. 안정적일 때만 24K를 같은 방식으로 측정한다.
4. 24K도 안정적일 때만 32K를 실험한다.
5. 30~60분짜리 실제 Pi 저장소 작업 한 건으로 장시간 loop를 확인한다.

검증: 기본값은 가장 빠른 값이 아니라 장시간 작업에서 pressure/swap이 악화되지 않는 값으로 유지한다. 이번 실측에서는 3.3K prompt가 통과했고 약 6.5K 이상은 prefill guard가 거부되어 24K/32K 승격을 보류한다. 단일 decode는 26.03~33.12 tok/s였지만 completion이 6~23 tokens로 짧았고, 두 번 모두 swap이 약 336~474MB 증가했다. 최소 `bash`만 허용한 Pi loop는 `./test.sh`를 실행해 10 checks/exit 0을 확인했지만, 기본 full coding tool schema는 약 20.3GB에서 guard를 넘었다.

### Phase 5 — 선택적 backend 비교 (나중)

oMLX 기준선이 남은 뒤에만 별도 branch에서 `mlx-dspark`를 비교한다. 동일 model family, context, prompt, 반복 횟수로 측정하며 16K 장시간 agent loop가 확실히 개선될 때만 교체를 논의한다. `llama.cpp IQ4_XS`는 oMLX 호환 문제가 실제로 발생했을 때 복구 문서만 추가한다.

## 7. Sol → Luna 작업 경계

Sol이 맡을 일:

- 설치된 버전의 공식 인터페이스 판별
- config schema와 불변식 확정
- 기존 설정을 보존하는 방식
- MTP/TurboQuant 호환성 분기
- memory/context 승격 조건
- 함수 골격과 실패 의미 정의

Luna에게 넘길 일:

- 설치/다운로드처럼 시간이 긴 실행
- `test.sh`와 smoke test 반복
- cold/warm benchmark 반복과 결과 정리
- 16K → 24K → 32K 순차 검증
- 실제 Pi 작업 장시간 실행
- 이미 정한 함수 경계 안의 작은 호환성 수정

Luna가 Sol로 되돌릴 조건:

- oMLX stable의 공식 설정 경로가 설계와 다름
- MTP 또는 tool parser가 checkpoint를 인식하지 못함
- 20GB memory limit에서도 모델 자체는 로드되지만, 16K profile의 큰 prompt가 prefill guard에 걸림
- 기존 Pi 설정을 보존하면서 provider를 추가할 방법이 없음
- 안전 불변식이나 공개 config 형식을 바꿔야 함

## 8. Git 저장 순서

원격: `https://github.com/dotcom07/LocalAgent-Mac.git`

원격은 현재 비어 있다. 구현을 시작할 때 로컬 저장소를 `main`으로 초기화하고 아래 단위로만 저장한다.

1. `docs: add implementation plan`
2. `feat: add read-only doctor and config validation`
3. `feat: add oMLX lifecycle commands`
4. `feat: connect Pi and add smoke verification`
5. `docs: record M4 Pro 24GB benchmark`

각 commit 전에 `./test.sh`를 실행한다. 모델 파일, 캐시, 개인 설정, 원시 prompt는 push하지 않는다.

## 9. 운영 순서

최종 사용 흐름은 아래보다 복잡해지지 않아야 한다.

```sh
cp local-agent.env.example local-agent.env
./local-agent doctor
./local-agent install
./local-agent configure
./local-agent start
./local-agent download-model
./local-agent pi
```

일상 운용은 `start`, `status`, `pi`, `stop` 네 동작만 필요하다. `verify`와 `bench`는 설치 후 검증할 때만 실행한다.
