# dsh-debug

Runtime debugger for [DeepSeek Harness](https://github.com/topics/dsh-plugin) — agents can stop a real program at a real line and read its real variables, instead of guessing or instrumenting code with temporary log lines.

```
你: 这个接口为什么 500?
agent: debug_run { breakpoints: [app/Services/OrderService.php:88] }
       → paused at line 88 · $payment = null · stack: attach() ← createOrder() ← …
agent: 原因找到了：$payment 在 line 84 的分支里没赋值。我来修。
```

No code changes, no `var_dump`, no guesswork. Every debug run is recorded in an audit log and variable values pass through secret redaction before reaching the model.

## Status

**Phase 0 — Go via Delve (DAP), tools only.** The session layer, DAP client, process supervision, redaction and the `debug_*` tool family are implemented and covered by an acceptance suite that runs against real Delve. PHP (Xdebug/DBGp) and the sidebar UI are on the roadmap below.

## Tools for the agent

| Tool | What it does |
|---|---|
| `debug_run` | Launch the workspace program (Go via `dlv dap`), set breakpoints, wait for the first stop / exit / timeout, and return one snapshot: location, stack, locals, requested expressions, output tail. |
| `debug_continue` | `continue` / `stepOver` / `stepIn` / `stepOut`, returns the snapshot at the next stop. |
| `debug_state` | Read the paused location/locals without running anything; safe to poll while the debuggee is running. |
| `debug_eval` | Evaluate one expression in the top frame of the paused debuggee. |
| `debug_output` | Read the captured stdout/stderr tail. |
| `debug_stop` | Terminate the debuggee and adapter. Idempotent. |
| `debug_list` | List live sessions (workspace, state, idle time). |

One session per workspace. Idle sessions are reaped after 10 minutes; sessions that are launching or running are never reaped mid-flight.

## Safety

- Every write path (launch, eval, continue) goes to `~/.dsh/dsh-debug-audit.jsonl`.
- Variable snapshots and process output pass through secret redaction (cloud keys, GitHub/GitLab/npm tokens, JWTs, private key blocks, `password=`/`token:` shapes) before they reach a model.
- The adapter (`dlv dap`) and its debuggee are killed as a process tree on stop, on idle-reap, and when the host unloads the plugin.
- Expression evaluation runs code inside the debuggee. That is the point of a debugger — scope sessions accordingly.

## Install

```bash
dsh plugin --profile web add @yxzpro/dsh-debug
# or desktop
dsh plugin --profile desktop add @yxzpro/dsh-debug
```

Requires `dlv` on PATH, or point `DSH_DEBUG_DLV` at the binary. **The Delve build must match your Go toolchain** — Delve refuses to launch otherwise. Pairing rule: install the Delve release whose minimum Go version covers yours, e.g. with Go 1.22:

```bash
go install github.com/go-delve/delve/cmd/dlv@v1.24.2
```

## Develop

```bash
npm test    # Phase 0 acceptance: drives lib/session.js against real Delve + fixture programs
```

The harness in `test/run-phase0.mjs` exercises launch → breakpoint → locals/expressions → continue → exit, conditional breakpoints, timeout → running → stop-without-orphans, and structured errors for bad targets.

## Roadmap

- **Phase 1** — PHP via Xdebug 3 (DBGp): CLI launch, web/FPM attach with trigger URLs, path mappings, config doctor.
- **Phase 2** — Sidebar UI: source view with breakpoint gutter, stack/variables/watch, evaluate console, status pill in the composer row.
- **Phase 3** — Workflows: debug this test/route/command, exception breakpoints, logpoints, hit counts.
- **Phase 4** — Remote & containers: SSH port forwards, in-container Xdebug, path mapping.

## License

MIT
