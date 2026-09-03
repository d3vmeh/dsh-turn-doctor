# dsh-turn-doctor

A diagnostic plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that tells you why a turn failed and which timeout or setting is actually responsible.

## Why this exists

A dsh request can time out in several different places:

* dsh's idle watchdog (`streamIdleTimeoutMs`)
* the SDK request timeout (`timeoutMs`)
* Node/undici HTTP timers
* the model server
* individual tool calls

The problem is that the UI usually only shows the final error message, and those messages aren't very specific.

For example, `Request timed out.` might be the SDK timeout or undici's 300-second headers timeout. `terminated` might mean undici gave up waiting for the response body, or the model server died.

That makes it easy to change the wrong setting and then watch the request fail at exactly 5:00 again. This has come up in discussions like #3157 and #4518.

`dsh-turn-doctor` measures each model request itself (time to first byte, longest gap between bytes, and total request time) and uses that timing to identify the most likely failure point.

Example:

```text
turn-doctor: session=session-ccc41e50 turn 1 attempt 1
  verdict: Node's HTTP headers timer (undici) gave up waiting for the server's first response after 300.6 s.
  evidence: no reply bytes in 300.6 s
  fix: install dsh-fetch-timeouts to raise Node's HTTP timers; on llama.cpp this usually means the request was deferred behind a busy slot
```

It also catches a couple of failures that are otherwise easy to miss, including failed compactions and tool timeouts.

## What it detects

| Layer                       | Typical message                                         | Suggested fix                                                                          |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| dsh idle watchdog           | `pi-ai stream idle timeout after Nms`                   | Raise `streamIdleTimeoutMs`; if the request was queued, check the gate or `--parallel` |
| Node headers timer (undici) | `Request timed out.` with no bytes at ~300 s            | Install/configure `dsh-fetch-timeouts`                                                 |
| SDK request timer           | `Request timed out.` at around `timeoutMs`              | Raise `timeoutMs` on the route                                                         |
| Node body timer (undici)    | `terminated` after ~300 s without data mid-response     | `dsh-fetch-timeouts`, or configure the server to send data/pings                       |
| Server closed/crashed       | `terminated` or `Connection error.` after a short gap   | Check the model server logs                                                            |
| Server unreachable          | `Connection error.` almost immediately                  | Check that the server is running and the URL/port are correct                          |
| Context overflow            | `request (N tokens) exceeds the available context size` | Compact, increase context, or lower the compaction threshold                           |
| Empty response              | Request completes with no content                       | Check `maxTokens` / reasoning effort                                                   |
| dsh-llm-gate queue          | `QUEUE_TIMEOUT`, `QUEUE_FULL`                           | Raise `queueTimeoutMs` or reduce subagent concurrency                                  |
| GPU fault                   | `ErrorDeviceLost`, `decode() failed`                    | Restart the server; try a smaller context                                              |
| llama.cpp router reload     | `500 proxy error`                                       | Check `--models-max`                                                                   |
| Failed compaction           | `summarization truncated at the token cap`              | Raise the compaction preset's summary cap                                              |
| Tool timeout                | `tool call timed out after Nms`                         | Raise that tool's `timeoutMs`                                                          |

Each retry attempt is diagnosed separately. dsh already shows retry countdowns, so turn-doctor doesn't duplicate them.

If the timing isn't enough to distinguish two possible causes, it says that rather than pretending to know.

## Install

```bash
dsh plugin --profile web add dsh-turn-doctor
```

That's it.

Verdicts are printed in the dsh terminal. You can also run `/why` in chat to see recent verdicts for the current session, including subagents.

If you've changed your route timeouts from the defaults, add them to `~/.dsh/profiles/web/cordis.patch.yml` so turn-doctor can classify failures correctly:

```yaml
- id: turn-doctor
  config:
    providers:
      llamacpp:
        streamIdleTimeoutMs: 7200000
        timeoutMs: 7200000
        undiciTimeoutMs: 1800000   # if dsh-fetch-timeouts is installed
    keep: 10                       # verdicts kept per session for /why
```

If a provider isn't configured, turn-doctor assumes the standard 300-second defaults.

## Notes

* turn-doctor only diagnoses failures. It doesn't retry requests, change settings, or inject anything into the model context.
* If the SDK timer and undici headers timer are both set to 300 seconds, a first-byte timeout can be ambiguous. In that case, turn-doctor reports undici because fixing it requires `dsh-fetch-timeouts`; dsh can't change that timer itself.
* Verdicts live in memory for the life of the dsh process (the last few per session, for `/why`). They are not written to the session log: dsh refuses to load a log containing event types it does not know, so a plugin event there would make the session unresumable.
* [dsh-error-lens](https://github.com/Wanbinyu/dsh-error-lens) is related, but solves a different problem: it shows recent failures in a web panel grouped by HTTP status. turn-doctor uses request timing to distinguish the different timeout layers, and also covers compactions and tool calls.

## License

MIT

