import { describe, it, expect } from 'vitest'
import { createStopwatch } from '../src/index.js'

function scripted(clock, steps) {
  return async function* () {
    for (const s of steps) {
      clock.t += s.advance
      if (s.throw) throw s.throw
      yield s.chunk
    }
  }()
}
const drain = async (gen) => { const out = []; for await (const c of gen) out.push(c); return out }

describe('stopwatch', () => {
  it('records first chunk, longest gap, count, finish, and passes chunks through', async () => {
    const clock = { t: 1000 }
    const sw = createStopwatch(() => clock.t)
    const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated' } } }
    const gen = sw.wrap({ sessionId: 's1', provider: 'p', model: 'm' }, () => scripted(clock, [
      { advance: 2100, chunk: { type: 'block-start', index: 0 } },
      { advance: 500, chunk: { type: 'text-delta', index: 0, text: 'x' } },
      { advance: 300100, chunk: finish },
    ]))
    const chunks = await drain(gen)
    expect(chunks).toHaveLength(3)
    const r = sw.lastFor('s1')
    expect(r.firstChunkAt - r.startedAt).toBe(2100)
    expect(r.longestGapMs).toBe(300100)
    expect(r.chunks).toBe(3)
    expect(r.finish).toEqual(finish.reason)
    expect(r.endedAt - r.startedAt).toBe(302700)
  })
  it('still records when downstream throws', async () => {
    const clock = { t: 0 }
    const sw = createStopwatch(() => clock.t)
    const gen = sw.wrap({ sessionId: 's2' }, () => scripted(clock, [{ advance: 50, throw: new Error('boom') }]))
    await expect(drain(gen)).rejects.toThrow('boom')
    expect(sw.lastFor('s2').endedAt).toBe(50)
    expect(sw.lastFor('s2').chunks).toBe(0)
  })
  it('keeps the record for calls without a sessionId out of the map', async () => {
    const sw = createStopwatch(() => 0)
    await drain(sw.wrap({}, () => scripted({ t: 0 }, [{ advance: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }])))
    expect(sw.size()).toBe(0)
  })
  it('caps stored sessions at 200, oldest evicted', () => {
    const sw = createStopwatch(() => 0)
    for (let i = 0; i < 210; i++) sw.store({ sessionId: 'x' + i, startedAt: 0, endedAt: 0, chunks: 0, longestGapMs: 0 })
    expect(sw.size()).toBe(200)
    expect(sw.lastFor('x9')).toBeUndefined()
    expect(sw.lastFor('x10')).toBeDefined()
  })
})
