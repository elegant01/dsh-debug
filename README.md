# dsh-debug

Runtime debugger for [DeepSeek Harness](https://github.com/topics/dsh-plugin) — agents can stop a real program at a real line and read its real variables, instead of guessing or instrumenting code with temporary log lines. **Go** (Delve/DAP) and **PHP** (Xdebug 3/DBGp), same tool surface.

```
你: 这个接口为什么 500?
agent: debug_run { language: "php", program: "public/index.php",
                    breakpoints: [{file: "app/Services/OrderService.php", line: 88}] }
       → paused at line 88 · $payment = null · stack: attach() ← createOrder() ← …
agent: 原因找到了：$payment 在 line 84 的分支里没赋值。我来修。
```

No code changes, no `var_dump`, no guesswork. Every debug run is recorded in an audit log and variable values pass through secret redaction before reaching the model.

## Status

**Phase 3 — Go (Delve/DAP) + PHP (Xdebug/DBGp), CLI and web attach, tools only.** Acceptance: 6/6 on Delve 1.24 + Go 1.22, 6/6 on Xdebug 3.1 + PHP 7.4 (CLI), 2/2 web attach against `php -S` with trigger mode. The sidebar UI is Phase 2 (roadmap below — phases numbered by internal order, attach landed early because it was the highest-value one).

## Tools for the agent

| Tool | What it does |
|---|---|
| `debug_run` | Launch the workspace program, set breakpoints, wait for the first stop / exit / timeout, and return one snapshot: location, stack, locals, requested expressions, output tail. |
| `debug_continue` | `continue` / `stepOver` / `stepIn` / `stepOut`, returns the snapshot at the next stop. |
| `debug_state` | Read the paused location/locals without running anything; safe to poll while the debuggee is running. |
| `debug_eval` | Evaluate one expression in the top frame of the paused debuggee. |
| `debug_output` | Read the captured stdout/stderr tail. |
| `debug_stop` | Terminate the debuggee and adapter. Idempotent. |
| `debug_list` | List live sessions (workspace, language, state, idle time). |

One session per workspace per language. `language` (`go` | `php`) is auto-detected from the program / `go.mod` / `composer.json` when omitted. Idle sessions are reaped after 10 minutes; sessions that are launching or running are never reaped mid-flight.

### PHP notes

- `debug_run` needs `program`: the entry `.php` script (absolute, or relative to the workspace).
- PHP runs against any local PHP with Xdebug 3 loaded: point `DSH_DEBUG_PHP` at the binary and, when Xdebug isn't already loaded by php.ini, `DSH_DEBUG_XDEBUG` at the extension dll/so. The session arms `xdebug.mode=debug` + `start_with_request=yes` per run — your php.ini stays untouched.

### Web attach (`attach: true`)

For web requests (FPM, Apache, `php -S`) or long-running workers you don't want the plugin to spawn, `debug_run` with `attach: true` arms the DBGp listener and answers with the trigger:

```json
{
  "status": "armed",
  "trigger": {
    "urlParam": "XDEBUG_SESSION=dsh-debug",
    "cookie": "XDEBUG_SESSION=dsh-debug",
    "listen": "127.0.0.1:54663"
  },
  "hint": "listener armed, no debugger connected yet — fire the request with the trigger, then poll debug_state"
}
```

The target PHP needs `xdebug.mode=debug`, `xdebug.start_with_request=trigger` (or `yes`), and `client_host/client_port` pointing at the listener (pin it with `port` when you need a known port for forwarding). Fire the request with the `XDEBUG_SESSION` trigger, the session pauses at your breakpoints, and `debug_continue` lets the HTTP response complete. Late connections are picked up — `debug_state` reports the snapshot whenever the request arrives.

For containers/remote hosts, `pathMappings: [{local, remote}]` translates breakpoint paths (you always give workspace-local paths) and maps reported paths back.

### Go notes

Requires `dlv` on PATH, or point `DSH_DEBUG_DLV` at the binary. **The Delve build must match your Go toolchain** — Delve refuses to launch otherwise. Pairing rule: install the Delve release whose minimum Go version covers yours, e.g. with Go 1.22:

```bash
go install github.com/go-delve/delve/cmd/dlv@v1.24.2
```

## Safety

- Every write path (launch, eval, continue) goes to `~/.dsh/dsh-debug-audit.jsonl`.
- Variable snapshots and process output pass through secret redaction (cloud keys, GitHub/GitLab/npm tokens, JWTs, private key blocks, `password=`/`token:` shapes) before they reach a model.
- Adapters and debuggees are killed as process trees on stop, on idle-reap, and when the host unloads the plugin.
- Expression evaluation runs code inside the debuggee. That is the point of a debugger — scope sessions accordingly.

## Install

```bash
dsh plugin --profile web add @yxzpro/dsh-debug
# or desktop
dsh plugin --profile desktop add @yxzpro/dsh-debug
```

## Develop

```bash
npm test         # both suites
npm run test:go  # Phase 0: drives lib/session.js against real Delve + fixture programs
npm run test:php # Phase 1: PHP fixtures through DBGp (expects .tools/php74 or DSH_DEBUG_PHP/DSH_DEBUG_XDEBUG)
```

## Roadmap

- **Phase 2** — Sidebar UI: source view with breakpoint gutter, stack/variables/watch, evaluate console, status pill in the composer row.
- **Phase 3** — Workflows: debug this test/route/command, web/FPM attach with trigger URLs, exception breakpoints, logpoints.
- **Phase 4** — Remote & containers: SSH port forwards, in-container Xdebug, path mappings.

## License

MIT
