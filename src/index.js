import Schema from '@deepseek-ai/schemastery'

export const name = 'turn-doctor'
export const inject = ['commands']

export const DEFAULT_TIMEOUTS = Object.freeze({
  streamIdleTimeoutMs: 300000,
  timeoutMs: 300000,
  undiciTimeoutMs: 300000,
})

export const Config = Schema.object({
  providers: Schema.dict(Schema.object({
    streamIdleTimeoutMs: Schema.number().min(1).default(DEFAULT_TIMEOUTS.streamIdleTimeoutMs),
    timeoutMs: Schema.number().min(1).default(DEFAULT_TIMEOUTS.timeoutMs),
    undiciTimeoutMs: Schema.number().min(1).default(DEFAULT_TIMEOUTS.undiciTimeoutMs),
  })).default({}),
  keep: Schema.number().min(1).max(100).default(10),
})


const sec = (ms) => (ms / 1000).toFixed(1)
const NEAR = 0.15
const near = (x, target) => x != null && target > 0 && Math.abs(x - target) <= target * NEAR

export function evidenceOf(record) {
  if (!record) return 'no timing recorded for this call'
  const total = (record.endedAt ?? record.startedAt) - record.startedAt
  if (!record.chunks) return `no reply bytes in ${sec(total)} s`
  const first = record.firstChunkAt - record.startedAt
  return `${record.chunks} chunks, first at ${sec(first)} s, longest silence ${sec(record.longestGapMs)} s, total ${sec(total)} s`
}

const FETCH_HINT = "install dsh-fetch-timeouts to raise Node's HTTP timers"

export function classify({ code = 'UNKNOWN', message = '', record, timeouts, configured = false }) {
  timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts }
  const elapsed = record ? (record.endedAt ?? record.startedAt) - record.startedAt : undefined
  const chunks = record?.chunks ?? 0
  const gap = record?.longestGapMs
  const evidence = evidenceOf(record)
  const which = configured ? 'your configured' : 'the default'
  const v = (layer, confidence, verdict, hint, extraEvidence) =>
    ({ layer, confidence, verdict, hint, evidence: extraEvidence ?? evidence })

  const watchdog = /stream idle timeout after (\d+)ms/.exec(message)
  if (watchdog) {
    const base = `raise llm-pi-ai.providers.<route>.streamIdleTimeoutMs (it fired at ${watchdog[1]} ms)`
    const hint = chunks === 0
      ? `${base}; no reply bytes ever arrived, so on llama.cpp the request may have been queued behind a busy slot (dsh-llm-gate or --parallel help)`
      : base
    return v('dsh-watchdog', 'exact', `dsh's own idle watchdog gave up after ${sec(Number(watchdog[1]))} s of silence.`, hint)
  }
  if (code === 'TIMEOUT' && /request timed out/i.test(message)) {
    if (chunks === 0 && near(elapsed, timeouts.undiciTimeoutMs))
      return v('undici-headers', 'timing',
        `Node's HTTP headers timer (undici) gave up waiting for the server's first response after ${sec(elapsed)} s.`,
        `${FETCH_HINT}; on llama.cpp this usually means the request was deferred behind a busy slot`)
    if (chunks === 0 && near(elapsed, timeouts.timeoutMs))
      return v('sdk-timer', 'timing',
        `the SDK request timer (timeoutMs) expired after ${sec(elapsed)} s with no response headers.`,
        'raise llm-pi-ai.providers.<route>.timeoutMs')
    return v('undici-or-sdk', 'guess',
      `a request timer expired after ${elapsed === undefined ? 'an unknown time' : `${sec(elapsed)} s`}; that matches neither ${which} undici timer (${sec(timeouts.undiciTimeoutMs)} s) nor ${which} timeoutMs (${sec(timeouts.timeoutMs)} s) closely.`,
      `${FETCH_HINT}, or raise timeoutMs; if you have changed either, set providers.<route> in my config and I can be specific`)
  }
  const closedText = /terminated|other side closed|premature close/i.test(message)
  if (code === 'TRANSPORT' || code === 'STREAM_CLOSED') {
    if (closedText && chunks > 0 && near(gap, timeouts.undiciTimeoutMs))
      return v('undici-body', 'timing',
        `Node's HTTP body timer (undici) cut the reply after ${sec(gap)} s of silence mid-stream.`,
        `${FETCH_HINT}, or use a server that sends keepalive pings (llama.cpp does, Ollama does not)`)
    if ((closedText || /connection error/i.test(message)) && chunks > 0)
      return v('server-closed', 'timing', 'the model server closed the connection while replying.',
        'check the model server log: crash, model unload, or a proxy dropping the stream')
    if (chunks === 0 && elapsed !== undefined && elapsed < 10000)
      return v('server-unreachable', 'timing',
        `the connection failed after ${sec(elapsed)} s; the server did not answer at all.`,
        'is the model server running, and is the route base URL and port right?')
    return v('transport', 'guess', 'the network transport failed; timing does not single out one layer.',
      `raw: ${code}: ${message}; possibilities: Node's HTTP timers (${FETCH_HINT}) or the server closing the connection`)
  }
  if (code === 'CONTEXT_WINDOW_EXCEEDED') {
    const m = /(\d+) tokens?\D+?(\d+) tokens?/.exec(message)
    return v('context-overflow', 'exact', "the prompt is bigger than the server's context window.",
      'compact the conversation, start the server with a larger context, or lower the compaction threshold',
      m ? `server reported ${m[1]} tokens requested, ${m[2]} available` : evidence)
  }
  if (code === 'EMPTY_RESPONSE')
    return v('empty-response', 'exact', 'the model finished without producing any content.',
      'usually a thinking model spending the whole output cap on reasoning: raise maxTokens or lower reasoningEffort')
  if (code === 'QUEUE_TIMEOUT' || code === 'QUEUE_FULL' || code === 'GATE_DISPOSED')
    return v('llm-gate', 'exact', 'dsh-llm-gate refused or timed out the request in its queue.',
      'raise llm-gate queueTimeoutMs or maxQueued, or run fewer concurrent subagents')
  if (/ErrorDeviceLost|decode\(\) failed/i.test(message))
    return v('gpu-fault', 'exact', 'the model server hit a GPU fault.',
      'restart the model server; the context was probably too large for the GPU')
  if (code === 'SERVER' && /proxy error/i.test(message))
    return v('router-lost-child', 'exact', 'the llama.cpp router lost its model process (reload in progress?).',
      'wait for the reload or check --models-max; a second model may be evicting the first')
  if (code === 'AUTH')
    return v('auth', 'exact', 'the server rejected the API key.', 'fix the apiKey on the route')
  if (code === 'RATE_LIMIT')
    return v('rate-limit', 'exact', 'the provider rate limited the request.', 'slow down or raise the provider limit')
  if (code === 'INVALID_REQUEST') {
    const m = /model '([^']+)' not found/.exec(message)
    return v('invalid-request', 'exact',
      m ? `the server does not know the model '${m[1]}'.` : 'the server rejected the request as invalid.',
      m ? `fix the model name '${m[1]}' on the route (or add the preset on the server)` : `raw: ${message}`)
  }
  if (code === 'SERVER')
    return v('server-error', 'exact', 'the model server returned a 5xx error.', 'check the model server log')
  return v('unknown', 'guess', 'no rule matched this failure.', `raw: ${code}: ${message}`)
}

export function classifyCompaction(error, record, timeouts = DEFAULT_TIMEOUTS, configured = false) {
  if (/truncated at the token cap/i.test(error))
    return { layer: 'compaction-token-cap', confidence: 'exact',
      verdict: 'the compaction summary was cut off at its token cap before it was complete.',
      hint: "raise the compaction preset's summary token limit, or use a model with a larger output cap for compaction",
      evidence: error }
  if (/no text summary content/i.test(error))
    return { layer: 'compaction-empty', confidence: 'exact',
      verdict: 'the compaction model produced no summary text (probably only reasoning).',
      hint: 'lower reasoningEffort for the compaction call or raise its token cap',
      evidence: error }
  return classify({ code: 'UNKNOWN', message: error, record, timeouts, configured })
}

export function classifyToolTimeout(toolName, message) {
  return { layer: 'tool-timeout', confidence: 'exact',
    verdict: `the tool ${toolName} hit its own deadline; the turn continued without its result.`,
    hint: "raise that tool's timeoutMs in its plugin config", evidence: message }
}

export function createStopwatch(now) {
  const last = new Map()
  const keyOf = (sessionId, purpose) => purpose ? `${sessionId}:${purpose}` : sessionId
  const store = (record) => {
    if (!record.sessionId) return
    const key = keyOf(record.sessionId, record.purpose)
    if (!last.has(key) && last.size >= 200) last.delete(last.keys().next().value)
    last.delete(key)
    last.set(key, record)
  }
  async function* wrap(options, next) {
    const record = { sessionId: options.sessionId, provider: options.provider, model: options.model,
      purpose: options.purpose, startedAt: now(), firstChunkAt: undefined, endedAt: undefined,
      longestGapMs: 0, chunks: 0, finish: undefined }
    let lastAt = record.startedAt
    try {
      for await (const chunk of next()) {
        const t = now()
        if (record.chunks === 0) record.firstChunkAt = t
        if (t - lastAt > record.longestGapMs) record.longestGapMs = t - lastAt
        lastAt = t
        record.chunks += 1
        if (chunk?.type === 'finish') record.finish = chunk.reason
        yield chunk
      }
    } finally {
      record.endedAt = now()
      store(record)
    }
  }
  return { wrap, store, lastFor: (id, purpose) => last.get(keyOf(id, purpose)), size: () => last.size }
}

const capAt200 = (map, key) => {
  if (!map.has(key) && map.size >= 200) map.delete(map.keys().next().value)
}

export function createReporter(ctx, config, now = Date.now) {
  const rings = new Map()
  const report = (session, verdict) => {
    const full = { ...verdict, at: now(), sessionId: session.id,
      parentSession: session.header?.parentSession }
    const head = full.kind === 'model'
      ? `turn ${full.turn ?? '?'}${full.attempt ? ` attempt ${full.attempt}` : ''}${full.terminal ? ' (terminal)' : ''}`
      : full.kind
    ctx.logger.info(`turn-doctor: session=${String(session.id).slice(0, 16)} ${head}\n  verdict: ${full.verdict}\n  evidence: ${full.evidence}\n  fix: ${full.hint}`)
    capAt200(rings, session.id)
    const ring = rings.get(session.id) ?? []
    ring.push(full)
    while (ring.length > config.keep) ring.shift()
    rings.set(session.id, ring)
    try { session.append('turn-doctor/verdict', full) } catch { /* session gone; terminal line already out */ }
  }
  return { report, list: (id) => rings.get(id) ?? [], rings }
}

export function createCollector({ stopwatch, reporter, config }) {
  const seen = new Map()
  const remember = (session, key) => {
    capAt200(seen, session.id)
    const s = seen.get(session.id) ?? new Set()
    if (s.has(key)) return false
    s.add(key)
    if (s.size > (config.keep ?? 10) * 4) s.delete(s.values().next().value)
    seen.set(session.id, s)
    return true
  }
  const contain = (fn) => (...args) => {
    try { return fn(...args) } catch (error) {
      if (reporter.internalError) reporter.internalError(error)
    }
  }
  const timeoutsFor = (provider) => ({ ...DEFAULT_TIMEOUTS, ...config.providers?.[provider] })
  const isConfigured = (provider) => Boolean(config.providers?.[provider])
  const origin = (session) => String(session.id).startsWith('session-') ? undefined : 'subagent'
  const lastRetry = (session, turn, step) => session.events.findLast(
    (e) => e.type === 'llm/retry' && e.data.turn === turn && (step === undefined || e.data.step === step))?.data

  const modelVerdict = (session, { turn, step, provider, failure, attempt, terminal, retrying }) => {
    if (failure?.code === 'ABORTED') return
    if (terminal) {
      const prev = reporter.list(session.id).at(-1)
      if (prev && prev.kind === 'model' && prev.turn === turn && !prev.terminal
        && prev.failure?.code === failure?.code && prev.failure?.message === failure?.message) {
        prev.terminal = true
        return
      }
    }
    const key = terminal ? `m:${turn}:t` : `m:${turn}:${step}:${attempt}`
    if (!remember(session, key)) return
    const record = stopwatch.lastFor(session.id)
    const verdict = classify({ code: failure?.code, message: failure?.message, record,
      timeouts: timeoutsFor(provider), configured: isConfigured(provider) })
    let evidence = verdict.evidence
    if (terminal) {
      const retry = lastRetry(session, turn)
      if (retry && retry.retry >= retry.maxRetries) evidence += `; retries exhausted (${retry.maxRetries})`
    }
    reporter.report(session, { ...verdict, evidence, kind: 'model', turn, step, attempt, terminal,
      retrying, origin: origin(session), failure: { code: failure?.code, message: failure?.message } })
  }

  const onSessionEvent = contain((session, event) => {
    const d = event.data
    if (event.type === 'llm/retry') {
      modelVerdict(session, { turn: d.turn, step: d.step, provider: d.provider, failure: d.failure,
        attempt: d.retry, retrying: { retry: d.retry, maxRetries: d.maxRetries, delayMs: d.delayMs } })
    } else if (event.type === 'turn/end' && d.reason?.kind === 'error') {
      modelVerdict(session, { turn: d.turn, provider: session.requestHeader?.()?.config?.provider,
        failure: d.reason.error, attempt: (lastRetry(session, d.turn)?.retry ?? 0) + 1, terminal: true })
    } else if (event.type === 'turn/end' && d.reason?.kind === 'max-tokens') {
      if (remember(session, `mt:${d.turn}`)) {
        reporter.report(session, { layer: 'max-tokens', confidence: 'exact', kind: 'model', turn: d.turn,
          origin: origin(session),
          verdict: 'the turn stopped because the output token cap was reached.',
          evidence: 'turn/end reason max-tokens',
          hint: 'raise maxTokens on the route, or ask the model to continue' })
      }
    } else if (event.type === 'compaction/end' && d.error) {
      if (remember(session, `c:${event.seq}`)) {
        reporter.report(session, { ...classifyCompaction(d.error, stopwatch.lastFor(session.id, 'compaction')),
          kind: 'compaction', origin: origin(session) })
      }
    } else if (event.type === 'tool/result' && d.error?.code === 'TOOL_TIMEOUT') {
      if (remember(session, `tt:${event.seq}`)) {
        const call = session.events.findLast((e) => e.type === 'tool/call' && e.data.callId === d.callId)
        reporter.report(session, { ...classifyToolTimeout(call?.data.name ?? 'a tool', d.error.message ?? ''),
          kind: 'tool', turn: d.turn, origin: origin(session) })
      }
    }
  })

  const onRequestError = contain((payload) => {
    const session = payload.agent.session
    modelVerdict(session, { turn: payload.turn, step: payload.step, provider: payload.provider,
      failure: payload.failure,
      attempt: (lastRetry(session, payload.turn, payload.step)?.retry ?? 0) + 1 })
  })

  return { onSessionEvent, onRequestError }
}

export function apply(ctx, config = {}, internals = {}) {
  const now = internals.now ?? Date.now
  const merged = { providers: {}, keep: 10, ...config }
  const stopwatch = createStopwatch(now)
  const reporter = createReporter(ctx, merged, now)
  reporter.internalError = (error) => ctx.logger.warn(`turn-doctor: internal error ${error?.stack ?? error}`)
  const collector = createCollector({ stopwatch, reporter, config: merged })

  ctx.logger.exporter({ export: (m) => {
    const line = m.args?.[0]
    if (typeof line === 'string' && line.startsWith('turn-doctor:')) console.log(line)
  } })

  ctx.effect(() => ctx.on('llm/stream', (options, next) => stopwatch.wrap(options, next)), 'turn-doctor: stopwatch')
  ctx.effect(() => ctx.on('session/event', (session, event) => collector.onSessionEvent(session, event)), 'turn-doctor: session events')
  ctx.effect(() => ctx.on('agent/request-error', (payload, next) => {
    try { collector.onRequestError(payload) } catch (error) { reporter.internalError(error) }
    return next()
  }), 'turn-doctor: request errors')
  ctx.effect(() => ctx.commands.register({
    name: 'why',
    description: 'Explain recent turn failures',
    handler: async (invocation) => {
      const id = invocation.agent?.session?.id
      const own = reporter.list(id)
      const children = [...reporter.rings.entries()]
        .filter(([sid]) => sid !== id && !String(sid).startsWith('session-'))
        .flatMap(([, list]) => list)
        .filter((v) => v.parentSession === id)
      const all = [...own, ...children].sort((a, b) => b.at - a.at).slice(0, merged.keep)
      if (!all.length) return { kind: 'success', text: 'No failures recorded in this session.' }
      const text = all.map((v) => [
        `${v.kind}${v.turn != null ? ` turn ${v.turn}` : ''}${v.attempt ? ` attempt ${v.attempt}` : ''}${v.terminal ? ' (terminal)' : ''}${v.origin === 'subagent' ? ` [subagent ${String(v.sessionId).slice(0, 8)}]` : ''}`,
        `  verdict: ${v.verdict}`,
        `  evidence: ${v.evidence}`,
        `  fix: ${v.hint}`,
      ].join('\n')).join('\n\n')
      return { kind: 'success', text }
    },
  }), 'turn-doctor: /why')
}
