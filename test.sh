#!/bin/zsh

set -eu

readonly ROOT=${0:A:h}
readonly TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/local-agent-test.XXXXXX")
trap 'rm -rf -- "$TEST_DIR"' EXIT

typeset -i passed=0

expect_ok() {
  local config=$1
  if LOCAL_AGENT_CONFIG=$config "$ROOT/local-agent" check-config >/dev/null; then
    passed+=1
  else
    print -u2 -- "expected success: $config"
    exit 1
  fi
}

expect_fail() {
  local config=$1
  if LOCAL_AGENT_CONFIG=$config "$ROOT/local-agent" check-config >/dev/null 2>&1; then
    print -u2 -- "expected failure: $config"
    exit 1
  fi
  passed+=1
}

valid=$TEST_DIR/valid.env
printf '%s\n' \
  'MODEL_ID=fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp' \
  'CONTEXT_TOKENS=16384' \
  'MEMORY_LIMIT_GB=19' \
  'REASONING_EFFORT=medium' > "$valid"
expect_ok "$valid"

invalid_context=$TEST_DIR/invalid-context.env
printf '%s\n' 'CONTEXT_TOKENS=65536' > "$invalid_context"
expect_fail "$invalid_context"

unknown_key=$TEST_DIR/unknown-key.env
printf '%s\n' 'HOST=0.0.0.0' > "$unknown_key"
expect_fail "$unknown_key"

unsupported_model=$TEST_DIR/unsupported-model.env
printf '%s\n' 'MODEL_ID=someone/another-model' > "$unsupported_model"
expect_fail "$unsupported_model"

marker=$TEST_DIR/should-not-exist
malicious=$TEST_DIR/malicious.env
printf 'MODEL_ID=$(touch %s)\n' "$marker" > "$malicious"
expect_fail "$malicious"
[[ ! -e $marker ]] || {
  print -u2 -- "config executed shell code"
  exit 1
}
passed+=1

if "$ROOT/local-agent" definitely-not-a-command >/dev/null 2>&1; then
  print -u2 -- "unknown command unexpectedly succeeded"
  exit 1
fi
passed+=1

fake_home=$TEST_DIR/home
fake_bin=$TEST_DIR/bin
mkdir -p "$fake_home/.omlx" "$fake_bin"
printf '%s\n' \
  '#!/bin/zsh' \
  '[[ ${1:-} == --version ]] && { print 0.6.2; exit 0; }' \
  'exit 0' > "$fake_bin/omlx"
chmod +x "$fake_bin/omlx"
printf '%s\n' \
  '{"version":"1.0","server":{"log_level":"debug"},"custom":{"keep":true}}' \
  > "$fake_home/.omlx/settings.json"
printf '%s\n' \
  '{"version":1,"models":{"other":{"temperature":0.7,"is_pinned":true,"is_default":true}}}' \
  > "$fake_home/.omlx/model_settings.json"

PATH="$fake_bin:$PATH" HOME=$fake_home LOCAL_AGENT_CONFIG=$valid \
  "$ROOT/local-agent" configure >/dev/null

jq -e '
  .custom.keep == true
  and .server.log_level == "debug"
  and .server.host == "127.0.0.1"
  and .scheduler.max_concurrent_requests == 1
  and .memory.memory_guard_custom_ceiling_gb == 19
  and .cache.enabled == true
' "$fake_home/.omlx/settings.json" >/dev/null
jq -e '
  .models.other.temperature == 0.7
  and .models.other.is_pinned == false
  and .models.other.is_default == false
  and .models["Qwen3.8-27B-MLX-oQ4e-mtp"].mtp_enabled == true
  and .models["Qwen3.8-27B-MLX-oQ4e-mtp"].turboquant_kv_enabled == false
  and .models["Qwen3.8-27B-MLX-oQ4e-mtp"].max_context_window == 16384
  and .models["Qwen3.8-27B-MLX-oQ4e-mtp"].chat_template_kwargs.reasoning_effort == "medium"
' "$fake_home/.omlx/model_settings.json" >/dev/null
[[ -f $fake_home/.omlx/settings.json.local-agent.bak ]]
[[ -f $fake_home/.omlx/model_settings.json.local-agent.bak ]]

before=$(shasum -a 256 "$fake_home/.omlx/settings.json" "$fake_home/.omlx/model_settings.json")
PATH="$fake_bin:$PATH" HOME=$fake_home LOCAL_AGENT_CONFIG=$valid \
  "$ROOT/local-agent" configure >/dev/null
after=$(shasum -a 256 "$fake_home/.omlx/settings.json" "$fake_home/.omlx/model_settings.json")
[[ $before == $after ]] || {
  print -u2 -- "configure is not idempotent"
  exit 1
}
passed+=1

printf '%s\n' \
  '#!/bin/zsh' \
  '[[ ${1:-} == --version ]] && { print 0.6.1; exit 0; }' \
  'exit 0' > "$fake_bin/omlx"
if PATH="$fake_bin:$PATH" HOME=$fake_home LOCAL_AGENT_CONFIG=$valid \
    "$ROOT/local-agent" configure >/dev/null 2>&1; then
  print -u2 -- "unsupported oMLX version unexpectedly succeeded"
  exit 1
fi
passed+=1

node --check "$ROOT/measure.mjs"
node "$ROOT/measure.mjs" --self-test >/dev/null
passed+=1

print -- "$passed checks passed"
