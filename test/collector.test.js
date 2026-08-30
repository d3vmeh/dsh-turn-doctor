import { describe, it, expect } from 'vitest'
import { createCollector, createStopwatch, createReporter } from '../src/index.js'
import { fakeCtx, fakeSession } from './helpers.js'

function setup(config = { providers: {}, keep: 10 }) {
  const ctx = fakeCtx()
  const sw = createStopwatch(() => 0)
  const rep = createReporter(ctx, config, () => 0)
  rep.internalError = (e) => { throw e }   // tests fail loudly on swallowed bugs
  const col = createCollector({ stopwatch: sw, reporter: rep, config })
  return { ctx, sw, rep, col }
}

describe('collector', () => {
  it('llm/retry event produces a retrying verdict with attempt', () => {
    const { sw, rep, col } = setup()
    const session = fakeSession()
    sw.store({ sessionId: session.id, startedAt: 0, endedAt: 302000, chunks: 0, longestGapMs: 302000 })
    col.onSessionEvent(session, { type: 'llm/retry', seq: 5, data: { retryId: 'r1', turn: 1, step: 2, provider: 'llamacpp',
      retry: 1, maxRetries: 5, delayMs: 500, failure: { code: 'TIMEOUT', message: 'Request timed out.' } } })
    const [v] = rep.list(session.id)
    expect(v.layer).toBe('undici-headers')
    expect(v.attempt).toBe(1)
    expect(v.terminal).toBeFalsy()
    expect(v.retrying).toEqual({ retry: 1, maxRetries: 5, delayMs: 500 })
  })
  it('turn/end error is terminal and notes exhaustion', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    session.events.push({ type: 'llm/retry', seq: 1, data: { turn: 3, step: 1, retry: 5, maxRetries: 5, provider: 'llamacpp', failure: { code: 'TRANSPORT', message: 'Connection error.' } } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 9, data: { turn: 3, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })
    const [v] = rep.list(session.id)
    expect(v.terminal).toBe(true)
    expect(v.evidence).toContain('retries exhausted (5)')
  })
  it('deduplicates the same event delivered twice', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    const ev = { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } }
    col.onSessionEvent(session, ev)
    col.onSessionEvent(session, ev)
    expect(rep.list(session.id)).toHaveLength(1)
  })
  it('request-error and the matching retry event yield one verdict per attempt', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    const failure = { code: 'AUTH', message: '401' }
    col.onRequestError({ agent: { session }, turn: 1, step: 2, provider: 'llamacpp', failure })
    col.onSessionEvent(session, { type: 'llm/retry', seq: 2, data: { retryId: 'r', turn: 1, step: 2, provider: 'llamacpp', retry: 1, maxRetries: 5, delayMs: 1, failure } })
    expect(rep.list(session.id)).toHaveLength(1)
  })
  it('a second attempt is a new verdict', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    const failure = { code: 'AUTH', message: '401' }
    col.onSessionEvent(session, { type: 'llm/retry', seq: 2, data: { retryId: 'r', turn: 1, step: 2, provider: 'llamacpp', retry: 1, maxRetries: 5, delayMs: 1, failure } })
    session.events.push({ type: 'llm/retry', seq: 2, data: { turn: 1, step: 2, retry: 1, maxRetries: 5, provider: 'llamacpp', failure } })
    col.onRequestError({ agent: { session }, turn: 1, step: 2, provider: 'llamacpp', failure })
    expect(rep.list(session.id)).toHaveLength(2)
    expect(rep.list(session.id)[1].attempt).toBe(2)
  })
  it('compaction, tool timeout and max-tokens verdicts', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    session.events.push({ type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c9', name: 'web_fetch', arguments: '{}' } })
    col.onSessionEvent(session, { type: 'compaction/end', seq: 1, data: { compactionId: 'c', error: 'summarization truncated at the token cap (incomplete checkpoint)' } })
    col.onSessionEvent(session, { type: 'tool/result', seq: 3, data: { turn: 1, step: 1, callId: 'c9',
      error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT', message: 'tool call timed out after 120000ms' } } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'max-tokens' } } })
    const layers = rep.list(session.id).map(v => v.layer)
    expect(layers).toEqual(['compaction-token-cap', 'tool-timeout', 'max-tokens'])
    expect(rep.list(session.id)[1].verdict).toContain('web_fetch')
  })
  it('successful tool results and completed turns are ignored', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    col.onSessionEvent(session, { type: 'tool/result', seq: 1, data: { turn: 1, step: 1, callId: 'x' } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    col.onSessionEvent(session, { type: 'compaction/end', seq: 4, data: { compactionId: 'c', turn: 1 } })
    expect(rep.list(session.id)).toHaveLength(0)
  })
  it('subagent sessions are labelled', () => {
    const { rep, col } = setup()
    const child = fakeSession('abc123def')
    col.onSessionEvent(child, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })
    expect(rep.list(child.id)[0].origin).toBe('subagent')
  })
  it('uses configured provider timeouts', () => {
    const { sw, rep, col } = setup({ providers: { llamacpp: { streamIdleTimeoutMs: 7200000, timeoutMs: 7200000, undiciTimeoutMs: 1800000 } }, keep: 10 })
    const session = fakeSession()
    sw.store({ sessionId: session.id, startedAt: 0, endedAt: 1801000, chunks: 0, longestGapMs: 1801000 })
    col.onSessionEvent(session, { type: 'llm/retry', seq: 1, data: { retryId: 'r', turn: 1, step: 1, provider: 'llamacpp',
      retry: 1, maxRetries: 5, delayMs: 1, failure: { code: 'TIMEOUT', message: 'Request timed out.' } } })
    expect(rep.list(session.id)[0].layer).toBe('undici-headers')
  })
  it('classifier errors are contained', () => {
    const { rep, col } = setup()
    rep.internalError = undefined
    const session = fakeSession()
    session.requestHeader = () => { throw new Error('nope') }
    expect(() => col.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })).not.toThrow()
  })
})

describe('review fixes', () => {
  it('ABORTED is not a failure and produces no verdict', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    col.onRequestError({ agent: { session }, turn: 1, step: 1, provider: 'p', failure: { code: 'ABORTED', message: 'pi-ai request aborted by caller' } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'ABORTED', message: 'pi-ai request aborted by caller' } } } })
    expect(rep.list(session.id)).toHaveLength(0)
  })
  it('terminal turn/end merges into the matching attempt verdict', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    const failure = { code: 'AUTH', message: '401' }
    col.onRequestError({ agent: { session }, turn: 1, step: 2, provider: 'llamacpp', failure })
    col.onSessionEvent(session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'error', error: failure } } })
    const list = rep.list(session.id)
    expect(list).toHaveLength(1)
    expect(list[0].terminal).toBe(true)
    expect(list[0].attempt).toBe(1)
  })
  it('terminal with a different failure still reports separately', () => {
    const { rep, col } = setup()
    const session = fakeSession()
    col.onRequestError({ agent: { session }, turn: 1, step: 2, provider: 'llamacpp', failure: { code: 'TRANSPORT', message: 'Connection error.' } })
    col.onSessionEvent(session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401' } } } })
    expect(rep.list(session.id)).toHaveLength(2)
  })
  it('a compaction call does not corrupt the turn failure evidence', () => {
    const { sw, rep, col } = setup()
    const session = fakeSession()
    sw.store({ sessionId: session.id, startedAt: 0, endedAt: 302000, chunks: 0, longestGapMs: 302000 })
    sw.store({ sessionId: session.id, purpose: 'compaction', startedAt: 0, endedAt: 4000, chunks: 2, firstChunkAt: 1000, longestGapMs: 3000 })
    col.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'Request timed out.' } } } })
    expect(rep.list(session.id)[0].layer).toBe('undici-headers')
  })
  it('partial provider timeouts fall back to defaults, no NaN', () => {
    const { sw, rep, col } = setup({ providers: { llamacpp: { streamIdleTimeoutMs: 7200000 } }, keep: 10 })
    const session = fakeSession()
    sw.store({ sessionId: session.id, startedAt: 0, endedAt: 100000, chunks: 0, longestGapMs: 100000 })
    col.onSessionEvent(session, { type: 'llm/retry', seq: 1, data: { retryId: 'r', turn: 1, step: 1, provider: 'llamacpp',
      retry: 1, maxRetries: 5, delayMs: 1, failure: { code: 'TIMEOUT', message: 'Request timed out.' } } })
    expect(rep.list(session.id)[0].verdict).not.toContain('NaN')
  })
})
