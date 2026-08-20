#!/usr/bin/env node

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT_MS = 300_000;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node measure.mjs --model MODEL ((--prompt TEXT | --prompt-file FILE) | --verify | --bench) [options]');
  process.exit(2);
}

function args(argv) {
  const out = { endpoint: DEFAULT_ENDPOINT, maxTokens: 256, timeoutMs: DEFAULT_TIMEOUT_MS, context: 16384, reasoningEffort: 'medium' };
  const value = (index, name) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) usage(`${name} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--verify' || arg === '--bench') {
      if (out.mode) usage('choose only one mode');
      out.mode = arg.slice(2);
    }
    else if (arg === '--endpoint') { out.endpoint = value(i, arg); i += 1; }
    else if (arg === '--model') { out.model = value(i, arg); i += 1; }
    else if (arg === '--prompt') { out.prompt = value(i, arg); i += 1; }
    else if (arg === '--prompt-file') { out.promptFile = value(i, arg); i += 1; }
    else if (arg === '--tools-file') { out.toolsFile = value(i, arg); i += 1; }
    else if (arg === '--max-tokens') { out.maxTokens = Number(value(i, arg)); i += 1; }
    else if (arg === '--timeout-ms') { out.timeoutMs = Number(value(i, arg)); i += 1; }
    else if (arg === '--context') { out.context = Number(value(i, arg)); i += 1; }
    else if (arg === '--reasoning-effort') { out.reasoningEffort = value(i, arg); i += 1; }
    else if (arg === '--output-json') { out.outputJson = value(i, arg); i += 1; }
    else usage(`unknown option: ${arg}`);
  }
  if (out.selfTest) return out;
  if (!out.model) usage('--model is required');
  const single = out.prompt != null || out.promptFile != null;
  if (Number(single) + Number(out.mode != null) !== 1) usage('choose one of --prompt/--prompt-file, --verify, or --bench');
  if (single && (out.prompt == null) === (out.promptFile == null)) usage('provide exactly one of --prompt or --prompt-file');
  if (!Number.isInteger(out.maxTokens) || out.maxTokens < 1) usage('--max-tokens must be a positive integer');
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1) usage('--timeout-ms must be a positive integer');
  if (![16384, 24576, 32768].includes(out.context)) usage('--context must be 16384, 24576, or 32768');
  if (!['low', 'medium', 'xhigh'].includes(out.reasoningEffort)) usage('--reasoning-effort must be low, medium, or xhigh');
  return out;
}

function parseSSE(text, state = {}) {
  state.events ??= [];
  state.buffer = (state.buffer ?? '') + text;
  const parts = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = parts.pop();
  for (const part of parts) {
    const data = part.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) state.events.push(data);
  }
  return state;
}

function finishSSE(state) {
  if (state.buffer?.trim()) parseSSE(`${state.buffer}\n\n`, state);
  return state.events ?? [];
}

function addDelta(result, delta, now) {
  if (!delta || typeof delta !== 'object') return;
  if (result.ttftMs == null && (delta.content || delta.reasoning_content || delta.tool_calls?.length)) result.ttftMs = now - result.startedAt;
  if (typeof delta.content === 'string') result.text += delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string') result.reasoning += reasoning;
  if (Array.isArray(delta.tool_calls)) result.toolCalls.push(...delta.tool_calls);
}

function metrics(result, endedAt) {
  const totalMs = endedAt - result.startedAt;
  const decodeMs = result.ttftMs == null ? totalMs : totalMs - result.ttftMs;
  const completion = result.completionTokens;
  return {
    ttft_ms: result.ttftMs,
    total_ms: totalMs,
    prompt_tokens: result.promptTokens,
    cached_prompt_tokens: result.cachedPromptTokens,
    completion_tokens: completion,
    decode_tok_s: completion != null && decodeMs > 0 ? completion * 1000 / decodeMs : null,
    total_tok_s: completion != null && totalMs > 0 ? completion * 1000 / totalMs : null,
    finish_reason: result.finishReason,
    server_prompt_tokens_per_second: result.serverPromptTokensPerSecond,
    server_generation_tokens_per_second: result.serverGenerationTokensPerSecond,
    server_time_to_first_token: result.serverTimeToFirstToken,
    server_prompt_eval_duration: result.serverPromptEvalDuration,
    server_generation_duration: result.serverGenerationDuration,
    server_total_time: result.serverTotalTime,
    has_text: result.text.length > 0,
    has_reasoning: result.reasoning.length > 0,
    has_tool_calls: result.toolCalls.length > 0,
    text: result.text,
    reasoning: result.reasoning,
    tool_calls: result.toolCalls,
  };
}

function addChunk(result, raw) {
  if (raw === '[DONE]') return;
  let chunk;
  try { chunk = JSON.parse(raw); } catch { return; }
  if (chunk.error?.message) {
    result.streamError = chunk.error.message;
    return;
  }
  const choice = chunk.choices?.[0];
  addDelta(result, choice?.delta, performance.now());
  if (choice?.finish_reason != null) result.finishReason = choice.finish_reason;
  if (!chunk.usage) return;
  result.promptTokens = chunk.usage.prompt_tokens ?? result.promptTokens;
  result.cachedPromptTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? result.cachedPromptTokens;
  result.completionTokens = chunk.usage.completion_tokens ?? result.completionTokens;
  result.serverPromptTokensPerSecond = chunk.usage.prompt_tokens_per_second ?? result.serverPromptTokensPerSecond;
  result.serverGenerationTokensPerSecond = chunk.usage.generation_tokens_per_second ?? result.serverGenerationTokensPerSecond;
  result.serverTimeToFirstToken = chunk.usage.time_to_first_token ?? result.serverTimeToFirstToken;
  result.serverPromptEvalDuration = chunk.usage.prompt_eval_duration ?? result.serverPromptEvalDuration;
  result.serverGenerationDuration = chunk.usage.generation_duration ?? result.serverGenerationDuration;
  result.serverTotalTime = chunk.usage.total_time ?? result.serverTotalTime;
}

async function measure(options) {
  const fs = await import('node:fs/promises');
  const prompt = options.prompt ?? (options.promptFile ? await fs.readFile(options.promptFile, 'utf8') : null);
  let tools = options.tools;
  if (!tools && options.toolsFile) {
    try { tools = JSON.parse(await fs.readFile(options.toolsFile, 'utf8')); }
    catch (error) { throw new Error(`invalid --tools-file JSON: ${error.message}`); }
    if (!Array.isArray(tools)) throw new Error('--tools-file must contain a JSON array');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = performance.now();
  let response;
  try {
    const apiKey = options.apiKey ?? process.env.OMLX_API_KEY;
    response = await fetch(`${options.endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages ?? [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 1,
        top_p: 0.95,
        top_k: 20,
        reasoning_effort: options.reasoningEffort ?? 'medium',
        chat_template_kwargs: { enable_thinking: options.enableThinking ?? true },
        ...(tools ? { tools, tool_choice: 'required' } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 2000)}`);
    }
    if (!response.body) throw new Error('response has no streaming body');
    const result = { startedAt, ttftMs: null, promptTokens: null, cachedPromptTokens: null, completionTokens: null, finishReason: null, serverPromptTokensPerSecond: null, serverGenerationTokensPerSecond: null, serverTimeToFirstToken: null, serverPromptEvalDuration: null, serverGenerationDuration: null, serverTotalTime: null, text: '', reasoning: '', toolCalls: [] };
    const state = {};
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parseSSE(decoder.decode(value, { stream: true }), state);
      for (const raw of state.events.splice(0)) addChunk(result, raw);
    }
    parseSSE(decoder.decode(), state);
    for (const raw of finishSSE(state)) addChunk(result, raw);
    if (result.streamError) throw new Error(result.streamError);
    return metrics(result, performance.now());
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`timeout after ${options.timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function verify(options) {
  const endpoint = options.endpoint.replace(/\/$/, '');
  const apiKey = options.apiKey ?? process.env.OMLX_API_KEY;
  const modelsResponse = await fetch(`${endpoint}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!modelsResponse.ok) throw new Error(`/v1/models returned HTTP ${modelsResponse.status}`);
  const models = await modelsResponse.json();
  if (!models.data?.some((model) => model.id === options.model)) throw new Error(`model not available: ${options.model}`);

  const text = await measure({ ...options, prompt: 'Reply with exactly LOCAL_AGENT_OK.', enableThinking: false, maxTokens: 32 });
  if (!text.has_text) throw new Error('text generation produced no final text');

  const reasoning = await measure({ ...options, prompt: 'Think briefly: is 17 greater than 9? End with exactly YES.', enableThinking: true, maxTokens: 1024 });
  if (!reasoning.has_reasoning || !reasoning.has_text) throw new Error('thinking generation did not contain both reasoning and final text');

  const tools = [{
    type: 'function',
    function: {
      name: 'lookup_weather',
      description: 'Look up weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    },
  }];
  const tool = await measure({ ...options, prompt: 'Call lookup_weather for Seoul.', tools, enableThinking: false, maxTokens: 128 });
  const call = tool.tool_calls.find((item) => item.function?.name === 'lookup_weather');
  if (!call) throw new Error('required tool call was not returned');
  try {
    if (!JSON.parse(call.function.arguments).city) throw new Error('missing city');
  } catch (error) {
    throw new Error(`tool call arguments are invalid: ${error.message}`);
  }

  const cachePrompt = `VERIFY-${Date.now()}\n${'stable prefix cache verification block. '.repeat(512)}\nReply with OK.`;
  const cacheSeed = await measure({ ...options, prompt: cachePrompt, enableThinking: false, maxTokens: 8 });
  const cacheWarm = await measure({ ...options, prompt: cachePrompt, enableThinking: false, maxTokens: 8 });
  if (!(cacheWarm.cached_prompt_tokens > (cacheSeed.cached_prompt_tokens ?? 0))) throw new Error('repeated prefix did not increase cached tokens');

  return { mode: 'verify', passed: true, model: options.model, text, reasoning, tool, cache: { seed: cacheSeed, warm: cacheWarm } };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function memorySnapshot() {
  const { execFile } = await import('node:child_process');
  const run = (command, argv) => new Promise((resolve) => execFile(command, argv, { encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim())));
  const [processes, swap] = await Promise.all([
    run('ps', ['-axo', 'pid=,rss=,command=']),
    run('sysctl', ['-n', 'vm.swapusage']),
  ]);
  const matches = processes?.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter((match) => match && /omlx/i.test(match[3]) && !/measure\.mjs/.test(match[3])) ?? [];
  return {
    captured_at: new Date().toISOString(),
    omlx_rss_bytes: matches.length ? matches.reduce((sum, match) => sum + Number(match[2]) * 1024, 0) : null,
    omlx_processes: matches.map((match) => ({ pid: Number(match[1]), rss_bytes: Number(match[2]) * 1024, command: match[3] })),
    swap,
  };
}

async function bench(options) {
  // Keep benchmark prompts below the 24GB-safe prefill guard; agent compaction
  // should leave the same headroom during a real session.
  const target = Math.floor(options.context * 0.20);
  const block = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.\n';
  let repeats = Math.floor(target / 16);
  const makePrompt = (nonce) => `${nonce}\n${block.repeat(repeats)}Reply with exactly OK.`;

  let calibration = await measure({ ...options, prompt: makePrompt('CALIBRATION-1'), enableThinking: false, maxTokens: 1 });
  if (!calibration.prompt_tokens) throw new Error('server did not report prompt_tokens');
  repeats = Math.max(1, Math.floor(repeats * target / calibration.prompt_tokens));
  calibration = await measure({ ...options, prompt: makePrompt('CALIBRATION-2'), enableThinking: false, maxTokens: 1 });
  if (calibration.prompt_tokens >= options.context - 64) throw new Error(`calibrated prompt is too large: ${calibration.prompt_tokens} tokens`);

  const memory = [await memorySnapshot()];
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    memory.push(await memorySnapshot());
    sampling = false;
  }, 1000);

  const cold = [];
  const warm = [];
  let result;
  try {
    for (let index = 1; index <= 3; index += 1) {
      cold.push(await measure({ ...options, prompt: makePrompt(`COLD-${Date.now()}-${index}`), enableThinking: false, maxTokens: 32 }));
    }
    const warmPrompt = makePrompt(`WARM-${Date.now()}`);
    const seed = await measure({ ...options, prompt: warmPrompt, enableThinking: false, maxTokens: 32 });
    for (let index = 0; index < 3; index += 1) warm.push(await measure({ ...options, prompt: warmPrompt, enableThinking: false, maxTokens: 32 }));
    result = {
      mode: 'bench',
      passed: warm.every((run) => run.cached_prompt_tokens > run.prompt_tokens * 0.5),
      model: options.model,
      context: options.context,
      calibration,
      cold,
      warm_seed: seed,
      warm,
      medians: {
        cold_ttft_ms: median(cold.map((run) => run.ttft_ms)),
        warm_ttft_ms: median(warm.map((run) => run.ttft_ms)),
        cold_prompt_tok_s: median(cold.map((run) => run.server_prompt_tokens_per_second)),
        warm_prompt_tok_s: median(warm.map((run) => run.server_prompt_tokens_per_second)),
        decode_tok_s: median([...cold, ...warm].map((run) => run.server_generation_tokens_per_second ?? run.decode_tok_s)),
        warm_cached_tokens: median(warm.map((run) => run.cached_prompt_tokens)),
      },
    };
  } finally {
    clearInterval(timer);
    memory.push(await memorySnapshot());
  }
  result.memory = {
    peak_omlx_rss_bytes: Math.max(...memory.map((sample) => sample.omlx_rss_bytes).filter(Number.isFinite), 0) || null,
    samples: memory,
  };
  return result;
}

function selfTest() {
  const parsed = args(['--model', 'model', '--prompt', 'hello', '--timeout-ms', '1']);
  if (parsed.model !== 'model' || parsed.prompt !== 'hello' || parsed.timeoutMs !== 1) throw new Error('argument parser failed');
  const state = {};
  parseSSE('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n', state);
  const events = finishSSE(state);
  if (events.length !== 2 || JSON.parse(events[0]).choices[0].delta.reasoning_content !== 'think') throw new Error('SSE parser failed');
  const result = { startedAt: 100, ttftMs: 50, promptTokens: 7, completionTokens: 10, finishReason: 'stop', text: 'hello', reasoning: 'think', toolCalls: [] };
  const measured = metrics(result, 250);
  if (measured.decode_tok_s !== 100 || measured.total_tok_s !== 66.66666666666667 || !measured.has_reasoning) throw new Error('metric calculation failed');
  const errorResult = { startedAt: 0, text: '', reasoning: '', toolCalls: [] };
  addChunk(errorResult, JSON.stringify({ error: { message: 'prefill failed' } }));
  if (errorResult.streamError !== 'prefill failed') throw new Error('SSE error handling failed');
  console.log('self-test: ok');
}

const options = args(process.argv.slice(2));
if (options.selfTest) selfTest();
else (options.mode === 'verify' ? verify(options) : options.mode === 'bench' ? bench(options) : measure(options)).then(async (result) => {
  const json = JSON.stringify(result, null, 2);
  if (options.outputJson) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(options.outputJson, `${json}\n`);
  }
  console.log(json);
  if (result.passed === false) process.exitCode = 1;
}).catch((error) => { console.error(`error: ${error.message}`); process.exitCode = 1; });
