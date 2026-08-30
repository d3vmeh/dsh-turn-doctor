import { describe, it, expect } from 'vitest'
import { classify, classifyCompaction, classifyToolTimeout, evidenceOf, DEFAULT_TIMEOUTS } from '../src/index.js'

const rec = (over = {}) => ({ sessionId: 's', provider: 'llamacpp', model: 'm', purpose: undefined,
  startedAt: 0, firstChunkAt: undefined, endedAt: 300100, longestGapMs: 300100, chunks: 0, finish: undefined, ...over })

describe('classify', () => {
  it('rule 1: watchdog names itself, queue note when no chunks', () => {
    const v = classify({ code: 'TIMEOUT', message: 'pi-ai stream idle timeout after 300000ms', record: rec(), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('dsh-watchdog')
    expect(v.confidence).toBe('exact')
    expect(v.hint).toContain('streamIdleTimeoutMs')
    expect(v.hint).toContain('queued')
  })
  it('rule 1: no queue note after chunks arrived', () => {
    const v = classify({ code: 'TIMEOUT', message: 'pi-ai stream idle timeout after 1800000ms', record: rec({ chunks: 50, firstChunkAt: 900 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('dsh-watchdog')
    expect(v.hint).not.toContain('queued')
  })
  it('rule 2: undici headers timer', () => {
    const v = classify({ code: 'TIMEOUT', message: 'Request timed out.', record: rec({ endedAt: 302000, longestGapMs: 302000 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('undici-headers')
    expect(v.hint).toContain('dsh-fetch-timeouts')
  })
  it('rule 3: sdk timer when values differ', () => {
    const t = { ...DEFAULT_TIMEOUTS, timeoutMs: 60000 }
    const v = classify({ code: 'TIMEOUT', message: 'Request timed out.', record: rec({ endedAt: 61000, longestGapMs: 61000 }), timeouts: t, configured: true })
    expect(v.layer).toBe('sdk-timer')
  })
  it('rule 4: ambiguous timeout hedges and invites config', () => {
    const v = classify({ code: 'TIMEOUT', message: 'Request timed out.', record: rec({ endedAt: 100000 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('undici-or-sdk')
    expect(v.confidence).toBe('guess')
    expect(v.hint).toContain('my config')
  })
  it('rule 5: undici body timer after chunks', () => {
    const v = classify({ code: 'TRANSPORT', message: 'terminated', record: rec({ chunks: 812, firstChunkAt: 2100, endedAt: 310000, longestGapMs: 300100 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('undici-body')
    expect(v.hint).toContain('keepalive')
  })
  it('rule 6: server closed on short gap', () => {
    const v = classify({ code: 'TRANSPORT', message: 'terminated', record: rec({ chunks: 40, firstChunkAt: 900, endedAt: 5000, longestGapMs: 1200 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('server-closed')
  })
  it('rule 7: unreachable fails fast', () => {
    const v = classify({ code: 'TRANSPORT', message: 'Connection error.', record: rec({ endedAt: 40, longestGapMs: 40 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('server-unreachable')
  })
  it('rule 8: transport fallback is a guess', () => {
    const v = classify({ code: 'TRANSPORT', message: 'Connection error.', record: rec({ endedAt: 60000, longestGapMs: 60000 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('transport')
    expect(v.confidence).toBe('guess')
  })
  it('rule 9: context overflow extracts numbers', () => {
    const v = classify({ code: 'CONTEXT_WINDOW_EXCEEDED', message: '400: {"code":400,"message":"request (35138 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error"}', record: rec(), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('context-overflow')
    expect(v.evidence).toContain('35138')
    expect(v.evidence).toContain('32768')
  })
  it('rule 10: empty response', () => {
    const v = classify({ code: 'EMPTY_RESPONSE', message: 'model "m" returned a completed response with no content', timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('empty-response')
    expect(v.hint).toContain('maxTokens')
  })
  it('rule 11: gate codes', () => {
    for (const code of ['QUEUE_TIMEOUT', 'QUEUE_FULL', 'GATE_DISPOSED'])
      expect(classify({ code, message: 'llm-gate', timeouts: DEFAULT_TIMEOUTS }).layer).toBe('llm-gate')
  })
  it('rule 12: gpu fault beats PI_AI_ERROR', () => {
    const v = classify({ code: 'PI_AI_ERROR', message: 'decode() failed: vk::Queue::submit: ErrorDeviceLost', record: rec({ chunks: 12, firstChunkAt: 5 }), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('gpu-fault')
  })
  it('rule 13: router proxy error', () => {
    expect(classify({ code: 'SERVER', message: '500 proxy error: Failed to read connection', timeouts: DEFAULT_TIMEOUTS }).layer).toBe('router-lost-child')
  })
  it('rule 14: model not found restated', () => {
    const v = classify({ code: 'INVALID_REQUEST', message: `400: {"code":400,"message":"model 'qwen3.8-q4' not found","type":"invalid_request_error"}`, timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('invalid-request')
    expect(v.hint).toContain('qwen3.8-q4')
  })
  it('rule 14: auth and rate limit pass-through', () => {
    expect(classify({ code: 'AUTH', message: '401', timeouts: DEFAULT_TIMEOUTS }).layer).toBe('auth')
    expect(classify({ code: 'RATE_LIMIT', message: '429', timeouts: DEFAULT_TIMEOUTS }).layer).toBe('rate-limit')
    expect(classify({ code: 'SERVER', message: '502', timeouts: DEFAULT_TIMEOUTS }).layer).toBe('server-error')
  })
  it('rule 15: unknown passes raw data through', () => {
    const v = classify({ code: 'WEIRD', message: 'zorp', record: rec(), timeouts: DEFAULT_TIMEOUTS })
    expect(v.layer).toBe('unknown')
    expect(v.hint).toContain('zorp')
    expect(v.evidence).toBe(evidenceOf(rec()))
  })
  it('missing record and defaults never throw', () => {
    expect(() => classify({ code: 'TIMEOUT', message: 'Request timed out.' })).not.toThrow()
    expect(classify({ code: 'TIMEOUT', message: 'Request timed out.' }).layer).toBe('undici-or-sdk')
  })
})

describe('classifyCompaction', () => {
  it('token cap', () => {
    const v = classifyCompaction('summarization truncated at the token cap (incomplete checkpoint)')
    expect(v.layer).toBe('compaction-token-cap')
    expect(v.hint).toContain('token')
  })
  it('no summary content', () => {
    expect(classifyCompaction('summarization produced no text summary content').layer).toBe('compaction-empty')
  })
  it('falls back to the main classifier', () => {
    expect(classifyCompaction('pi-ai stream idle timeout after 300000ms').layer).toBe('dsh-watchdog')
  })
})

describe('classifyToolTimeout', () => {
  it('names the tool', () => {
    const v = classifyToolTimeout('web_fetch', 'tool call timed out after 120000ms')
    expect(v.layer).toBe('tool-timeout')
    expect(v.verdict).toContain('web_fetch')
    expect(v.hint).toContain('timeoutMs')
  })
})
