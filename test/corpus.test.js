// Every distinct failure message observed on the owner's machine (local-failure-corpus.jsonl,
// 2026-08-30) must classify to a non-unknown layer with a hint.
import { describe, it, expect } from 'vitest'
import { classify, classifyCompaction, DEFAULT_TIMEOUTS } from '../src/index.js'

const rec = (over = {}) => ({ sessionId: 's', startedAt: 0, endedAt: 300100, longestGapMs: 300100, chunks: 0, ...over })

const CASES = [
  ['TIMEOUT', 'pi-ai stream idle timeout after 300000ms', rec(), 'dsh-watchdog'],
  ['TIMEOUT', 'pi-ai stream idle timeout after 1800000ms', rec({ endedAt: 1800100, longestGapMs: 1800100 }), 'dsh-watchdog'],
  ['TIMEOUT', 'Request timed out.', rec({ endedAt: 302000, longestGapMs: 302000 }), 'undici-headers'],
  ['TRANSPORT', 'Connection error.', rec({ endedAt: 900, longestGapMs: 900 }), 'server-unreachable'],
  ['SERVER', '500 proxy error: Failed to read connection', rec(), 'router-lost-child'],
  ['PI_AI_ERROR', 'decode() failed: vk::Queue::submit: ErrorDeviceLost', rec({ chunks: 3, firstChunkAt: 10 }), 'gpu-fault'],
  ['CONTEXT_WINDOW_EXCEEDED', '400: {"code":400,"message":"request (35138 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":35138,"n_ctx":32768}', rec(), 'context-overflow'],
  ['INVALID_REQUEST', `400: {"code":400,"message":"model 'qwen3.8-q4' not found","type":"invalid_request_error"}`, rec(), 'invalid-request'],
  ['AUTH', '401: {"message":"Invalid API Key","type":"authentication_error","code":401}', rec(), 'auth'],
  ['TRANSPORT', 'terminated', rec({ chunks: 200, firstChunkAt: 1500, endedAt: 310000, longestGapMs: 300050 }), 'undici-body'],
]

describe('local failure corpus', () => {
  for (const [code, message, record, layer] of CASES) {
    it(`${code}: ${message.slice(0, 60)}`, () => {
      const v = classify({ code, message, record, timeouts: DEFAULT_TIMEOUTS })
      expect(v.layer).toBe(layer)
      expect(v.hint.length).toBeGreaterThan(10)
    })
  }
  it('compaction corpus', () => {
    expect(classifyCompaction('summarization truncated at the token cap (incomplete checkpoint)').layer).toBe('compaction-token-cap')
    expect(classifyCompaction('summarization produced no text summary content').layer).toBe('compaction-empty')
    expect(classifyCompaction('pi-ai stream idle timeout after 300000ms').layer).toBe('dsh-watchdog')
  })
})

// Live run 2026-08-30: a 330 s pre-headers stall through real dsh produced this record.
import { createStopwatch } from '../src/index.js'
describe('live regression: pre-headers stall', () => {
  it('classifies as undici-headers despite synthetic usage and finish chunks', async () => {
    const clock = { t: 0 }
    const sw = createStopwatch(() => clock.t)
    const gen = sw.wrap({ sessionId: 's', provider: 'stall' }, () => (async function* () {
      clock.t += 300700
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'Request timed out.' } } }
    })())
    for await (const c of gen) void c
    const v = classify({ code: 'TIMEOUT', message: 'Request timed out.', record: sw.lastFor('s'), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('undici-headers')
  })
})
