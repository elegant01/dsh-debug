/**
 * dsh-debug — browser half.
 *
 * Registers a "Debug" tab with dsh-better-sidebar's tab service. The panel is
 * a thin remote control for the host's debug sessions: it renders snapshots
 * from /dsh-debug/api and sends run/continue/eval/stop actions back. All
 * debugging happens in the host process; this file never touches a debugger.
 *
 * No build step, no ui-primitives: `require('react')` + createElement, inline
 * styles, text buttons — the same constraint dsh-ide-git documented.
 */

window.__ModuleLoader__.load({
  id: '@yxzpro/dsh-debug',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const API = '/dsh-debug/api'

    async function apiGet(action, params) {
      const qs = new URLSearchParams(params).toString()
      const res = await fetch(`${API}/${action}?${qs}`, { headers: { accept: 'application/json' } })
      return res.json()
    }

    async function apiPost(action, payload) {
      const res = await fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return res.json()
    }

    // --- styles ---------------------------------------------------------------

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', fontSize: 12, fontFamily: 'inherit', color: 'inherit' },
      toolbar: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.25)', flexWrap: 'wrap' },
      btn: { padding: '2px 8px', border: '1px solid rgba(128,128,128,.4)', borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      btnDisabled: { opacity: 0.35, cursor: 'not-allowed' },
      btnDanger: { borderColor: '#c45c5c', color: '#e08a8a' },
      pill: { padding: '1px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
      section: { borderBottom: '1px solid rgba(128,128,128,.2)', padding: '6px 8px' },
      sectionTitle: { fontWeight: 600, fontSize: 11, opacity: 0.65, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11 },
      input: { flex: 1, minWidth: 60, background: 'transparent', border: '1px solid rgba(128,128,128,.4)', borderRadius: 4, color: 'inherit', padding: '2px 6px', fontSize: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 },
      body: { flex: 1, overflowY: 'auto', minHeight: 0 },
      outputBox: { maxHeight: 180, overflow: 'auto', background: 'rgba(128,128,128,.08)', borderRadius: 4, padding: '4px 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      errorBox: { color: '#e08a8a', padding: '4px 8px', whiteSpace: 'pre-wrap' },
      hint: { opacity: 0.55, padding: '2px 0' },
      linkBtn: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, padding: '0 2px' },
      location: { padding: '4px 8px', background: 'rgba(90,140,250,.12)', borderLeft: '3px solid rgba(90,140,250,.7)' },
    }

    const STATE_LABELS = {
      paused: '已暂停',
      running: '运行中',
      launching: '启动中',
      armed: '监听中',
      exited: '已退出',
      terminated: '已终止',
      error: '错误',
      'no-session': '无会话',
    }

    const STATE_COLORS = {
      paused: { background: 'rgba(230,180,60,.2)', color: '#e0b040' },
      running: { background: 'rgba(90,160,250,.18)', color: '#6aa4f0' },
      launching: { background: 'rgba(90,160,250,.18)', color: '#6aa4f0' },
      armed: { background: 'rgba(150,120,240,.18)', color: '#a58cf0' },
      exited: { background: 'rgba(90,180,90,.18)', color: '#6ab86a' },
      terminated: { background: 'rgba(128,128,128,.18)', color: '#999' },
      error: { background: 'rgba(220,90,90,.18)', color: '#e08a8a' },
      'no-session': { background: 'rgba(128,128,128,.12)', color: '#888' },
    }

    function Pill({ state }) {
      const style = STATE_COLORS[state] ?? STATE_COLORS['no-session']
      return h('span', { style: { ...S.pill, ...style } }, STATE_LABELS[state] ?? state)
    }

    /** First-run guide: what this is and the two ways to drive it. */
    function GuideCard({ language }) {
      const step = { margin: '6px 0', lineHeight: 1.7 }
      const code = { ...S.mono, background: 'rgba(128,128,128,.12)', borderRadius: 3, padding: '0 4px' }
      const card = { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '10px 12px', margin: '8px 0' }
      const h3 = { margin: '0 0 6px', fontSize: 13 }
      return h('div', { style: { padding: '8px' } },
        h('div', { style: card },
          h('h3', { style: h3 }, '🐞 这是什么'),
          h('div', { style: { opacity: 0.8, lineHeight: 1.7 } },
            '运行时调试器：把真实程序停在你指定的某一行，直接看当时的变量、调用栈——不用加日志、不用猜。agent 在对话里也能驱动它（debug_run 等工具），这个面板就是同一套东西的遥控器。')),
        h('div', { style: card },
          h('h3', { style: h3 }, '本机程序：4 步'),
          h('div', { style: step }, `1. 左上角选语言（当前：${language === 'php' ? 'PHP' : language === 'node' ? 'Node' : 'Go'}）`),
          h('div', { style: step }, '2. 填入口程序：', h('br'),
            h('span', { style: code }, language === 'php' ? 'artisan（或任意 .php 脚本）' : language === 'node' ? 'index.js / xxx.ts' : '留空 = 整个 Go 包')),
          h('div', { style: step }, '3. 加断点：', h('span', { style: code }, language === 'php' ? 'app/Services/OrderService.php:88' : language === 'node' ? 'src/server.js:42' : 'main.go:14'), ' 回车'),
          h('div', { style: step }, '4. 点 ▶ 运行 → 停住后下面出现变量、调用栈、输出；可继续/单步/求值')),
        language === 'php' && h('div', { style: card },
          h('h3', { style: h3 }, 'Web 接口调试（远程/容器里的 PHP）'),
          h('div', { style: step }, '1. 先开隧道（一个终端挂着）：', h('br'), h('span', { style: code }, 'ssh -N -R 9003:127.0.0.1:9003 <你的虚拟机>')),
          h('div', { style: step }, '2. 点上面「监听请求」按钮（按钮变紫 = 监听中）'),
          h('div', { style: step }, '3. 带触发器发请求：', h('span', { style: code }, '?XDEBUG_SESSION=dsh-debug')),
          h('div', { style: step }, '4. 请求会卡在断点上——这里看变量，点 ⏵ 放行后接口才返回')),
        h('div', { style: { ...S.hint, padding: '0 4px' } }, '每工作区每语言一个会话；停着不动 10 分钟自动回收。变量里的密钥会先脱敏再给模型。'),
      )
    }

    function Btn({ label, title, onClick, disabled, danger }) {
      return h('button', {
        style: { ...S.btn, ...(disabled ? S.btnDisabled : {}), ...(danger ? S.btnDanger : {}) },
        title, disabled: !!disabled,
        onClick: () => { if (!disabled) onClick?.() },
      }, label)
    }

    // --- value tree -----------------------------------------------------------

    function ValueTree({ name, value, depth }) {
      const [open, setOpen] = useState(depth < 1)
      const isObj = value !== null && typeof value === 'object'
      if (!isObj) {
        return h('div', { style: { ...S.mono, paddingLeft: depth * 12 } },
          h('span', { style: { opacity: 0.75 } }, `${name}: `),
          h('span', null, String(value)))
      }
      const header = value._type ?? value._value ?? 'object'
      const keys = Object.keys(value).filter((k) => k !== '_type' && k !== '_value')
      return h('div', null,
        h('div', { style: { ...S.mono, paddingLeft: depth * 12, cursor: 'pointer' }, onClick: () => setOpen(!open) },
          h('span', { style: { opacity: 0.5, display: 'inline-block', width: 10 } }, open ? '▾' : '▸'),
          h('span', { style: { opacity: 0.75 } }, `${name}: `),
          h('span', { style: { opacity: 0.9 } }, String(header))),
        open && keys.map((k) => h(ValueTree, { key: k, name: k, value: value[k], depth: depth + 1 })))
    }

    // --- main panel -------------------------------------------------------------

    function DebugPanel({ scope, visible }) {
      const workspace = scope?.cwd ?? ''
      const [language, setLanguage] = useState('go')
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [program, setProgram] = useState('')
      const [bpInput, setBpInput] = useState('')
      const [breakpoints, setBreakpoints] = useState([])
      const [evalInput, setEvalInput] = useState('')
      const [evalHistory, setEvalHistory] = useState([])
      const [output, setOutput] = useState('')
      const busyRef = useRef(false)

      const bpKey = `dsh-debug.bps.${workspace}`
      useEffect(() => {
        try { setBreakpoints(JSON.parse(localStorage.getItem(bpKey) || '[]')) } catch { setBreakpoints([]) }
      }, [bpKey])
      const saveBps = (bps) => { setBreakpoints(bps); try { localStorage.setItem(bpKey, JSON.stringify(bps)) } catch { /* full */ } }

      const refresh = useCallback(async () => {
        if (!workspace) return
        try {
          const [stateRes, outRes] = await Promise.all([
            apiGet('state', { workspace, language }),
            apiGet('output', { workspace, language, maxChars: 8000 }),
          ])
          if (stateRes?.ok) { setSnapshot(stateRes.snapshot); setError(null) }
          else if (stateRes?.error) setError(stateRes.error.message)
          if (outRes?.ok) setOutput(outRes.output ?? '')
        } catch (err) { setError(String(err?.message ?? err)) }
      }, [workspace, language])

      useEffect(() => {
        if (!visible) return undefined
        refresh()
        const timer = setInterval(() => { if (!busyRef.current) refresh() }, 1500)
        return () => clearInterval(timer)
      }, [visible, refresh])

      const act = async (action, payload) => {
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          const res = await apiPost(action, { workspace, language, ...payload })
          if (!res?.ok) setError(res?.error?.message ?? 'request failed')
          if (res?.snapshot) setSnapshot(res.snapshot)
          if (res?.result) setEvalHistory((h0) => [res.result, ...h0].slice(0, 20))
          await refresh()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }

      const state = snapshot?.status ?? 'no-session'
      const paused = state === 'paused'
      const running = state === 'running' || state === 'launching'
      const active = paused || running

      const addBreakpoint = () => {
        const match = /^(.+):(\d+)$/.exec(bpInput.trim())
        if (!match) return
        const [, file, line] = match
        if (breakpoints.some((b) => b.file === file && b.line === Number(line))) return
        saveBps([...breakpoints, { file, line: Number(line) }])
        setBpInput('')
      }

      const runArgs = () => ({
        program: program || undefined,
        breakpoints,
        timeoutMs: 60_000,
      })

      return h('div', { style: S.root },
        // toolbar
        h('div', { style: S.toolbar },
          h(Pill, { state }),
          h('select', {
            value: language, onChange: (e) => setLanguage(e.target.value),
            style: { ...S.input, flex: '0 0 auto' }, disabled: active,
          }, h('option', { value: 'go' }, 'Go'), h('option', { value: 'php' }, 'PHP'), h('option', { value: 'node' }, 'Node')),
          h(Btn, { label: '▶ 运行', title: '启动程序并停在第一个断点（没断点就直接跑完）', disabled: busy || active || !workspace, onClick: () => act('run', runArgs()) }),
          h(Btn, { label: '监听请求', title: 'PHP Web 调试：武装监听器，等带触发器的 HTTP 请求连上来（远程/容器先开 ssh -R 隧道）', disabled: busy || active || !workspace || language !== 'php', onClick: () => act('run', { attach: true, breakpoints, timeoutMs: 5000 }) }),
          h(Btn, { label: '⏵', title: '继续运行', disabled: busy || !paused, onClick: () => act('continue', { action: 'continue' }) }),
          h(Btn, { label: '⤼', title: '单步跳过（不进入函数）', disabled: busy || !paused, onClick: () => act('continue', { action: 'stepOver' }) }),
          h(Btn, { label: '⤓', title: '单步进入（进入函数）', disabled: busy || !paused, onClick: () => act('continue', { action: 'stepIn' }) }),
          h(Btn, { label: '⤒', title: '跳出当前函数', disabled: busy || !paused, onClick: () => act('continue', { action: 'stepOut' }) }),
          h(Btn, { label: '⏹', title: '结束调试会话', danger: true, disabled: busy || (!active && state !== 'armed'), onClick: () => act('stop', {}) }),
        ),
        error && h('div', { style: S.errorBox }, `⚠ ${error}`),
        !workspace && h('div', { style: { ...S.section, ...S.hint } }, '这个会话还没有工作区——先在工作区里开一个会话'),

        h('div', { style: S.body },
          // 空会话引导
          state === 'no-session' && !error && h(GuideCard, { language }),

          // paused location
          snapshot?.location && h('div', { style: S.location },
            h('div', { style: S.mono }, `停在 ${snapshot.location.path ?? ''}:${snapshot.location.line ?? ''}`),
            h('div', { style: { opacity: 0.6 } }, snapshot.location.function ?? '')),

          // armed trigger info
          state === 'armed' && snapshot?.trigger && h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, '监听器已武装，等请求上门'),
            h('div', { style: { lineHeight: 1.8 } },
              h('div', null, '带触发器发请求：'),
              h('div', { style: S.mono }, `  URL 参数  ?${snapshot.trigger.urlParam}`),
              h('div', { style: S.mono }, `  Cookie    ${snapshot.trigger.cookie}`),
              h('div', { style: { ...S.mono, ...S.hint } }, `目标 PHP 的 Xdebug：${snapshot.trigger.xdebugConfig}`),
              h('div', { style: { ...S.mono, ...S.hint } }, '远程/容器先开隧道：ssh -N -R 9003:127.0.0.1:9003 <虚拟机>'))),

          // program + run config
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, '目标'),
            h('div', { style: S.row },
              h('input', { style: S.input, placeholder: language === 'php' ? '入口脚本：artisan / public/index.php / xxx.php' : language === 'node' ? '入口文件：index.js / xxx.ts' : 'Go 包目录（留空 = 工作区根）', value: program, onChange: (e) => setProgram(e.target.value), disabled: active }),
            ),
            h('div', { style: S.row },
              h('input', { style: S.input, placeholder: '加断点：文件路径:行号，如 app/Services/OrderService.php:88', value: bpInput, onChange: (e) => setBpInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') addBreakpoint() }, disabled: active }),
              h(Btn, { label: '+ 断点', title: '添加断点', disabled: active || !bpInput.trim(), onClick: addBreakpoint }),
            ),
            breakpoints.length > 0 && h('div', { style: { marginTop: 4 } },
              breakpoints.map((bp) => h('div', { key: `${bp.file}:${bp.line}`, style: { ...S.mono, display: 'flex', justifyContent: 'space-between' } },
                h('span', null, `● ${bp.file}:${bp.line}`),
                h('button', { style: S.linkBtn, title: '删除这个断点', onClick: () => saveBps(breakpoints.filter((b) => b !== bp)), disabled: active }, '×'),
              ))),
          ),

          // locals
          snapshot?.locals && h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, `变量（${Object.keys(snapshot.locals).length}）`),
            Object.entries(snapshot.locals).map(([k, v]) => h(ValueTree, { key: k, name: k, value: v, depth: 0 }))),

          // expressions from the snapshot
          snapshot?.expressions && h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, '表达式'),
            Object.entries(snapshot.expressions).map(([k, v]) =>
              h('div', { key: k, style: S.mono }, h('span', { style: { opacity: 0.7 } }, `${k} = `), h('span', null, typeof v === 'object' ? JSON.stringify(v) : String(v)))),

          // eval console
          paused && h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, '求值（在暂停的栈顶帧里执行）'),
            h('div', { style: S.row },
              h('input', { style: { ...S.input, ...S.mono }, placeholder: language === 'php' ? '$order->status' : language === 'node' ? 'items.length' : 'len(items)', value: evalInput, onChange: (e) => setEvalInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && evalInput.trim()) { act('eval', { expression: evalInput.trim() }); setEvalInput('') } } }),
              h(Btn, { label: '求值', disabled: busy || !evalInput.trim(), onClick: () => { act('eval', { expression: evalInput.trim() }); setEvalInput('') } }),
            ),
            evalHistory.slice(0, 5).map((r, i) => h('div', { key: i, style: { ...S.mono, marginTop: 3 } },
              h('span', { style: { opacity: 0.6 } }, `${r.expression} → `),
              h('span', null, r.error ? `⚠ ${r.error.message}` : (typeof r.result === 'object' ? JSON.stringify(r.result) : String(r.result)))))),

          // stack
          snapshot?.stack && h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, `调用栈（${snapshot.stack.length}）`),
            snapshot.stack.slice(0, 30).map((f, i) =>
              h('div', { key: i, style: { ...S.mono, opacity: i === 0 ? 1 : 0.7 } }, `${f.name}  ${(f.path ?? '').split(/[\\/]/).pop()}:${f.line}`)))),

          // output
          h('div', { style: S.section },
            h('div', { style: S.sectionTitle }, '输出'),
            output ? h('div', { style: { ...S.outputBox, ...S.mono } }, output) : h('div', { style: S.hint }, '（暂无输出）')),
        ),
      )
    }

    // --- registration -----------------------------------------------------------

    /** Render-time airbag: a panel error must never take the shell's sidebar down with it. */
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      componentDidCatch(err) { try { console.error('[dsh-debug] panel render error:', err) } catch { /* no console */ } }
      render() {
        if (this.state.err) {
          return h('div', { style: { padding: 12, color: '#e08a8a', fontSize: 12, whiteSpace: 'pre-wrap' } },
            '调试面板渲染出错（不影响其他功能）：', String(this.state.err?.message ?? this.state.err))
        }
        return this.props.children
      }
    }

    const bugIcon = (size = 16) => {
      try {
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor' },
          h('path', { d: 'M8 2a3 3 0 0 0-3 3v.34L3.6 4.2a.75.75 0 0 0-.8 1.26L4.3 6.7c-.2.34-.3.72-.3 1.1v.7H2.25a.75.75 0 0 0 0 1.5H4v.55c0 .24.03.47.08.7l-1.6 1.6a.75.75 0 1 0 1.06 1.05l1.34-1.33A3 3 0 0 0 8 13.5a3 3 0 0 0 3.12-2.15l1.34 1.33a.75.75 0 0 0 1.06-1.06l-1.6-1.6c.05-.22.08-.45.08-.69V10h1.75a.75.75 0 0 0 0-1.5H12v-.7c0-.38-.1-.76-.3-1.1l1.5-1.24a.75.75 0 0 0-.8-1.26L11 5.34V5a3 3 0 0 0-3-3Zm-1.5 3c0-.83.67-1.5 1.5-1.5S9.5 4.17 9.5 5v.5h-3V5Z' }))
      } catch {
        return h('span', { style: { fontSize: size } }, '🐞')
      }
    }

    /** The cwd of the conversation currently on screen (mainView retention). */
    function findCurrentCwd(ctx) {
      try {
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
        for (const row of Object.values(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0 && typeof row.cwd === 'string') return row.cwd
        }
        const first = Object.values(byId)[0]
        return typeof first?.cwd === 'string' ? first.cwd : ''
      } catch { return '' }
    }

    /** Native main-area page: no scope arrives here, so discover the workspace ourselves. */
    function DebugPage({ ctx }) {
      const [cwd, setCwd] = useState(() => findCurrentCwd(ctx))
      useEffect(() => {
        if (cwd) return undefined
        const timer = setInterval(() => {
          const found = findCurrentCwd(ctx)
          if (found) setCwd(found)
        }, 2000)
        return () => clearInterval(timer)
      }, [ctx, cwd])
      return h(ErrorBoundary, null, h(DebugPanel, { scope: { cwd }, visible: true }))
    }

    function apply(ctx) {
      try { console.log('[dsh-debug] client loaded') } catch { /* no console */ }
      const disposers = []

      // Primary: the NATIVE slot system (dsh-codearts pattern) — a sidebar
      // panellist entry whose icon opens the main-area page. No third-party
      // service to wait for. A locale namespace is registered because the
      // shell resolves entry labels through the locale service.
      try {
        const locale = ctx.get?.('locale') ?? ctx.locale
        let t = null
        if (locale?.register && locale?.bind) {
          disposers.push(locale.register('dsh-debug', {
            zh: { tabLabel: '调试' },
            en: { tabLabel: 'Debug' },
          }))
          t = locale.bind('dsh-debug')
        }
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots?.inject && slots?.register) {
          disposers.push(slots.inject('sidebar.panellist', () =>
            slots.register({
              name: 'sidebar.panellist',
              id: 'dsh-debug',
              order: 50,
              label: t ? () => t('tabLabel') : () => 'Debug',
              locale: 'dsh-debug',
            }, ({ size }) => bugIcon(size))))
          disposers.push(slots.inject('main', () =>
            slots.register({
              name: 'main',
              key: 'dsh-debug',
              locale: 'dsh-debug',
              inject: () => ({}),
            }, () => h(DebugPage, { ctx }))))
          try { console.log('[dsh-debug] native sidebar panel registered') } catch { /* no console */ }
        } else {
          try { console.warn('[dsh-debug] slots service unavailable') } catch { /* no console */ }
        }
      } catch (err) {
        try { console.warn('[dsh-debug] native slots registration failed:', err) } catch { /* no console */ }
      }

      // Secondary: dsh-better-sidebar's tab system, when present. Its service
      // shows up whenever its client half is ready; poll a while.
      const descriptor = {
        id: 'debug',
        title: () => 'Debug',
        description: () => 'Debugger: breakpoints, stack, variables, evaluate — Go (Delve), PHP (Xdebug), Node (CDP)',
        icon: bugIcon,
        order: 25,
        single: true,
        badge: () => null,
        component: ({ scope, visible }) => h(DebugPanel, { scope, visible }),
      }
      let registeredBs = false
      const probeService = () => {
        try { const s = ctx.get?.('betterSidebar'); if (s) return s } catch { /* property rules differ by host */ }
        try { return ctx.betterSidebar } catch { return undefined }
        return undefined
      }
      const tryRegisterBs = () => {
        const service = probeService()
        if (!service || typeof service.registerTab !== 'function' || registeredBs) return false
        try {
          disposers.push(service.registerTab(descriptor))
          registeredBs = true
          try { console.log('[dsh-debug] better-sidebar tab registered') } catch { /* no console */ }
          return true
        } catch (err) {
          try { console.warn('[dsh-debug] better-sidebar registerTab failed:', err) } catch { /* no console */ }
          return false
        }
      }
      if (!tryRegisterBs()) {
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          if (tryRegisterBs() || tries > 120) clearInterval(timer)
        }, 500)
        disposers.push(() => clearInterval(timer))
      }

      return () => { for (const d of disposers.splice(0)) { try { d?.() } catch { /* gone */ } } }
    }

    exports.apply = apply
    // Both HOST services — always present, so the fiber activates at boot.
    // Accessing ctx.locale WITHOUT declaring it throws ("cannot get property
    // without inject"); a plugin-provided service here would park the fiber
    // in pending forever. The optional betterSidebar surface stays out of
    // this list and is polled for inside apply().
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
