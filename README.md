# LocalAgent-Mac

M4 Pro 24GB에서 `Pi -> oMLX -> Qwen3.8-27B oQ4e-MTP` 한 구성을 운영하기 위한 최소 래퍼다. 서버, downloader, KV cache, Pi 설정은 oMLX가 소유하며 이 저장소는 안전한 기본값과 실행 순서만 고정한다.

## 확인된 기준

2026-08-20에 아래 공식 소스와 실제 checkpoint를 확인했다.

- oMLX stable `v0.6.2`: lifecycle CLI, tiered SSD cache, Pi integration, Qwen native MTP 설정 지원
- `fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp`: 공개·비-gated, MTP head 포함, 실제 저장 크기 16.99GB
- Pi: deprecated된 `@mariozechner` 패키지 대신 후속 `@earendil-works/pi-coding-agent` 사용

주의: 확인 시점의 공식 Homebrew formula는 이름상 `0.6.3rc1`을 가리키면서 GitHub에는 stable로 잘못 표시돼 있었다. `./local-agent install`은 `rc/dev` formula를 거부한다. 그동안은 공식 `v0.6.2` macOS 15 DMG를 먼저 설치한다. DMG SHA256은 `0728fa3f1004f4165e67f32995e98a69f47b53c649f7e2f3cc94fb629d819097`다.

이 DMG 원본 번들은 macOS 15.6.1의 `codesign --verify --deep --strict`에서 invalid signature를 반환했다. 다운로드 SHA는 GitHub release 값과 일치하지만 정상 notarization을 검증할 수 없으므로, 공식 final formula가 나오면 그 설치를 우선한다.

## 사용법

```sh
cp local-agent.env.example local-agent.env
./test.sh
./local-agent doctor
./local-agent install
./local-agent configure
./local-agent start
./local-agent download-model
```

`download-model`이 연 oMLX Admin에서 표시된 Hugging Face ID를 내려받는다. 완료 후:

```sh
./local-agent status
./local-agent verify
./local-agent bench
./local-agent pi
```

`verify`는 text, thinking, required tool call, 반복 prefix cache hit를 확인한다. `bench`는 설정된 context의 약 20% 길이에서 cold 3회와 warm 3회를 측정한다. 현재 모델 RSS와 prefill guard 변동을 감안해 verify에서 통과한 범위로 고정한 값이며, context 상한 자체는 설정값(기본 16K)으로 유지된다. 결과는 `results/<timestamp>-<mode>/summary.json`에 저장되며 prompt 원문은 저장하지 않는다.

Admin 최초 진입 시 설정한 API key는 `~/.omlx/settings.json`에만 남는다. 래퍼는 필요한 API 호출에 이 값을 자동 사용하며 화면이나 결과 파일에는 출력하지 않는다.

Pi 인자는 그대로 전달된다.

```sh
./local-agent pi --resume
```

## 고정된 안전값

- bind: `127.0.0.1:8000`
- context: 16K 기본, 명시적으로만 24K/32K
- output: 8K
- process memory ceiling: 20GB (19GB rejected this model's 16K prefill; 20GB is the measured ceiling that still leaves macOS headroom)
- concurrent requests: 1
- Lightning MTP: ON
- TurboQuant, DFlash, ANE prefill: OFF
- SSD prefix cache: ON, hot cache: 1GB
- thinking: ON, reasoning effort: medium
- sampling: temperature 1.0, top-p 0.95, top-k 20

`configure`는 oMLX가 중지된 동안 JSON을 원자적으로 갱신하고 기존 파일을 최초 한 번만 `*.local-agent.bak`으로 보존한다. 다른 모델의 설정은 유지하지만 24GB에서 함께 올라오지 않도록 pin/default만 해제한다.

## 복구

```sh
./local-agent stop
cp ~/.omlx/settings.json.local-agent.bak ~/.omlx/settings.json
cp ~/.omlx/model_settings.json.local-agent.bak ~/.omlx/model_settings.json
./local-agent start
```

백업이 존재하는 파일만 복원한다.

## 알려진 시작·메모리 주의점

- DMG 설치 뒤 bundle의 `omlx-cli`를 `~/.local/bin`에 직접 연결하면 앱 관리 shim보다 PATH 앞에 놓여 숨겨진 CLI 설정 모달에서 시작이 멈출 수 있다. 별도 링크를 만들지 말고 oMLX가 만든 `~/.omlx/bin/omlx`를 사용한다.
- 이 M4 Pro 24GB에서는 Apple 기본 Metal ceiling이 16GB로 감지됐다. 래퍼는 `iogpu.wired_limit_mb`를 자동 변경하지 않는다. 실제 model load가 실패할 때만 시스템 전역 변경 여부를 별도로 결정한다.

## 실제 머신에서 남은 작업

- stable 설치와 16.99GB 모델 다운로드 완료
- `verify`와 16K-profile `bench` 완료 (실제 안정 prompt는 약 3.3K tokens; 6.5K 이상은 prefill guard가 거부)
- 24K/32K 측정은 16K profile의 prefill 한계가 해소될 때까지 보류
- 30~60분 실제 Pi 저장소 작업은 사용할 저장소와 작업을 정한 뒤 실행

## 실제 검증 결과 (2026-08-21)

- `iogpu.wired_limit_mb=22528`을 macOS 관리자 인증으로 일시 적용해야 모델이 로드됐다. 재부팅 시 원복되며, 저장소는 영구 sysctl 설정을 만들지 않는다.
- `verify` 통과: text, thinking+final, required tool call, prefix cache.
- `bench` 통과: 3,263 prompt tokens, cold TTFT 중앙값 33.1s, warm 13.6s, warm cached 2,048 tokens, peak oMLX RSS 17.60GB.
- 측정 중 swap은 6.19GB에서 6.06GB로 증가하지 않았다. 이미 존재하던 swap이므로 장시간 운용 전 다른 메모리 사용 앱을 정리한다.
- 16K는 API/model context 상한으로 설정했지만, 이 24GB 조합에서 약 6.5K 이상 prefill은 oMLX guard가 거부했다. 따라서 24K/32K 실험과 “16K prompt 안정” 주장은 보류한다.
- 단일 decode 측정(2,884 prompt / 6 completion tokens)은 prefill 106.75 tok/s, generation 33.12 tok/s, TTFT 27.02s였다. 23-token 재측정은 generation 26.03 tok/s, TTFT 23.72s였다. 짧은 completion이라 속도는 참고값으로만 본다.
- 두 decode 측정에서 swap이 각각 약 +336MB, +474MB 증가해 추가 반복과 장시간 Pi loop는 보류한다. 서버는 guard 오류 없이 idle로 돌아왔다.
- Pi 연결은 `./local-agent pi --no-session --tools bash --print ...`로 실제 `./test.sh` 실행, `10 checks passed`, exit 0을 확인했다. 기본 full coding tool schema는 약 20.3GB에서 prefill/memory guard를 넘으므로 24GB에서 안정 프로필로 취급하지 않는다.
