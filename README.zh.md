# dsh-debug

DeepSeek Harness 的运行时调试器——让 agent 把真实程序停在真实的一行上、读到真实的变量值，而不是靠猜，也不是往代码里临时塞日志。**Go**（Delve/DAP）和 **PHP**（Xdebug 3/DBGp）共用同一套工具面。

```
你: 这个接口为什么 500?
agent: debug_run { language: "php", program: "public/index.php",
                    breakpoints: [{file: "app/Services/OrderService.php", line: 88}] }
       → 停在第 88 行 · $payment = null · 调用栈: attach() ← createOrder() ← …
agent: 原因找到了：$payment 在 84 行的分支里没赋值。我来修。
```

不改代码、不加 `var_dump`、不靠猜。每次调试都写审计日志，变量值在喂给模型之前会过一遍密钥脱敏。

## 现状

**Go（Delve/DAP）+ PHP（Xdebug/DBGp），CLI 与 Web attach，工具 + 侧栏 UI。** 验收全部跑在真实调试器上：Go 6/6（Delve 1.24 + Go 1.22）、PHP CLI 6/6（Xdebug 3.1 + PHP 7.4）、Web attach 2/2（php -S trigger 模式）、VM 远程调试实测通过（dev2/dev3）。

## 界面

装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 后，右侧栏 `+` 里会出现 **Debug** 页签：

- 状态丸（paused / running / armed / exited…）+ Go/PHP 切换
- ▶ Run、Attach（武装监听器等请求）、Continue、Step over / into / out、⏹ Stop
- 目标程序 + 断点编辑（`文件路径:行号` 回车添加，按工作区记忆）
- 变量树、表达式、求值控制台（暂停时可用）、调用栈、进程输出尾部

## Agent 工具

| 工具 | 作用 |
|---|---|
| `debug_run` | 启动目标程序，下断点，等到第一个停止/退出/超时，一次返回快照：位置、栈、局部变量、表达式、输出尾部 |
| `debug_continue` | continue / stepOver / stepIn / stepOut，返回下一个停止点的快照 |
| `debug_state` | 不打扰地读当前状态：暂停位置/变量，或 running/exited 状态；可轮询 |
| `debug_eval` | 在暂停的栈顶帧求值一个表达式（`$order->status`、`len(items)`） |
| `debug_output` | 读被调试进程的 stdout/stderr 尾部 |
| `debug_stop` | 结束调试会话（幂等） |
| `debug_list` | 列出存活会话（工作区、语言、状态、空闲时长） |

每工作区每语言一个会话。`language` 不传时自动识别（.php 程序 / go.mod / composer.json）。空闲 10 分钟自动回收；正在跑的会话绝不误杀。

### PHP 说明

- `debug_run` 需要 `program`：入口 `.php` 脚本（绝对路径或相对工作区）。
- 本机 PHP 装了 Xdebug 3 就能用：`DSH_DEBUG_PHP` 指二进制，`DSH_DEBUG_XDEBUG` 指扩展 dll/so（php.ini 没装的话）。每次运行用 `-d` 临时武装 `xdebug.mode=debug` + `start_with_request=yes`，**不动你的 php.ini**。
- CLI 覆盖 artisan、PHPUnit、worker、消费者等。

### Web attach（`attach: true`）

调 Web 请求（FPM / Apache / php -S）或不想由插件起进程的场景：`debug_run` 带 `attach: true`，武装 DBGp 监听器并返回触发方式：

```json
{
  "status": "armed",
  "trigger": {
    "urlParam": "XDEBUG_SESSION=dsh-debug",
    "cookie": "XDEBUG_SESSION=dsh-debug",
    "listen": "127.0.0.1:54663"
  }
}
```

目标 PHP 需要 `xdebug.mode=debug`、`xdebug.start_with_request=trigger`（或 `yes`）、`client_host/client_port` 指向监听器（远程/转发场景用 `port` 固定端口）。带着 trigger 发请求，会话就停在断点上；`debug_continue` 放行后 HTTP 响应正常完成。请求迟到了也能被 `debug_state` 拾取。

容器/远程主机用 `pathMappings: [{local, remote}]` 做路径双向翻译（断点永远写本地路径）。**注意 remote 侧是 PHP 进程视角的路径**——lamp 容器里是 `/data/app/app_default/wwwroot/...`，不是 VM 宿主机的 `/var/www/html/...`。

### Go 说明

需要 `dlv`（或 `DSH_DEBUG_DLV` 指过去）。**Delve 版本必须和 Go 工具链匹配**，否则拒绝启动。例如 Go 1.22：

```bash
go install github.com/go-delve/delve/cmd/dlv@v1.24.2
```

## 远程调试（VM / 容器）

完整的实测配方在 [docs/remote-debugging.md](./docs/remote-debugging.md)。核心是一条 SSH 反向隧道，不需要 Windows 防火墙放行、不暴露 LAN：

```bash
ssh -N -R 9003:127.0.0.1:9003 <你的虚拟机>
```

## 安全

- 所有写操作（启动、求值、继续）记入 `~/.dsh/dsh-debug-audit.jsonl`
- 变量快照和进程输出过密钥脱敏（云密钥、GitHub/GitLab/npm token、JWT、私钥块、`password=` 形态）再进模型
- 停止/回收/插件卸载时按进程树杀干净，不留孤儿
- 表达式求值 = 在被调试进程里执行代码。这是调试器的本职——按需开启会话

## 安装

```bash
dsh plugin --profile web add @yxzpro/dsh-debug
# 或桌面端
dsh plugin --profile desktop add @yxzpro/dsh-debug
```

## 开发

```bash
npm test         # 全部套件
npm run test:go  # Phase 0：真 Delve + fixture
npm run test:php # Phase 1：PHP CLI（需要 .tools/php74 或 DSH_DEBUG_PHP/DSH_DEBUG_XDEBUG）
npm run test:web # Phase 3：php -S web attach
```

## 路线图

- 侧栏 UI 增强：源码视图 + 断点槽、多请求 attach、启动配置
- 工作流：「调试这个测试 / 这条路由 / 这个命令」一键化、异常断点、logpoint
- 更多语言：Python（debugpy）、Node——DAP 适配器即可接入

## License

MIT
