import { describe, it, expect } from 'vitest'
import { Config } from '../src/index.js'

describe('Config', () => {
  it('defaults', () => {
    const c = new Config({})
    expect(c.keep).toBe(10)
    expect(c.providers).toEqual({})
  })
  it('fills provider defaults', () => {
    const c = new Config({ providers: { llamacpp: { streamIdleTimeoutMs: 7200000 } } })
    expect(c.providers.llamacpp.streamIdleTimeoutMs).toBe(7200000)
    expect(c.providers.llamacpp.undiciTimeoutMs).toBe(300000)
    expect(c.providers.llamacpp.timeoutMs).toBe(300000)
  })
  it('rejects non-positive values', () => {
    expect(() => new Config({ providers: { x: { timeoutMs: 0 } } })).toThrow()
    expect(() => new Config({ keep: 0 })).toThrow()
  })
})
