export function fakeCtx() {
  const listeners = {}
  const logs = []
  const commands = []
  const state = { exporter: undefined }
  return {
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return () => {} },
    effect: (fn) => fn(),
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      exporter: (e) => { state.exporter = e },
    },
    commands: { register: (c) => { commands.push(c); return () => {} } },
    _: { listeners, logs, commands, get exporter() { return state.exporter } },
  }
}

export function fakeSession(id = 'session-1', header = {}) {
  const appended = []
  return {
    id,
    header,
    events: [],
    append: (type, data) => appended.push({ type, data }),
    appended,
    requestHeader: () => ({ config: { provider: 'llamacpp', model: 'm' } }),
  }
}

// dsh 0.1.2 (alpha.4 onward) removed the `events` array; the log is read through snapshotEvents().
export function fakeSessionAlpha(id = 'session-1', header = {}) {
  const log = []
  return {
    id,
    header,
    log,
    snapshotEvents: () => log.slice(),
    requestHeader: () => ({ config: { provider: 'llamacpp', model: 'm' } }),
  }
}
