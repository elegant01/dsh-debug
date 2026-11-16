# Remote debugging: the VM setup (appwork-l13 / dev3)

How the pieces fit, and what was changed where. All of it is trigger-mode: a
request without the `XDEBUG_SESSION` trigger pays zero cost and never
connects.

```
Windows (DSH / dsh-debug)                     VM (VirtualBox)
┌─────────────────────────┐                   ┌──────────────────────────┐
│ DBGp listener           │ ◄── ssh -R ────── │ 127.0.0.1:9003           │
│ 127.0.0.1:9003          │    9003 tunnel    │   ▲                      │
└─────────────────────────┘                   │   │ xdebug.client_host   │
                                              │ php83-fpm (host systemd) │
                                              │ php74-fpm (lamp 容器)    │
                                              └──────────────────────────┘
```

## One-time setup (done once, lives in the VM)

```bash
# 1. SSH reverse tunnel: VM 127.0.0.1:9003 → Windows 127.0.0.1:9003
ssh -N -R 9003:127.0.0.1:9003 goServer
```

2. Xdebug for the VM-host php83 is built and installed:

   ```
   /usr/local/php83/lib/php/extensions/no-debug-non-zts-20230831/xdebug.so
   ```

   and `/usr/local/php83/lib/php.ini` carries a marked block:

   ```ini
   ; --- dsh-debug xdebug (trigger mode, zero impact on normal requests) ---
   zend_extension=xdebug.so
   xdebug.mode=debug
   xdebug.start_with_request=trigger
   xdebug.client_host=127.0.0.1
   xdebug.client_port=9003
   xdebug.idekey=dsh-debug
   ```

   Remove the block + `sudo systemctl restart php83-fpm` to uninstall.

## Debugging a request

```js
debug_run {
  language: 'php',
  attach: true,
  port: 9003,
  pathMappings: [{ local: 'F:/centos/appwork-l13', remote: '/var/www/html/appwork-l13' }],
  breakpoints: [{ file: 'app/Services/OrderService.php', line: 88 }],
}
// → status 'armed' + trigger info
```

Then hit any dev3 URL with the trigger:

```bash
curl "http://dev3.mapi.4399youpai.com/app/xxx?XDEBUG_SESSION=dsh-debug" -H '...'
```

The session pauses at the breakpoint, `debug_eval` / `debug_state` /
`debug_continue` work as usual, and the HTTP response completes on continue.
Slow pages can outrun the default timeout — a `running` reply just means "the
request is still executing", poll again.

## Notes

- `pathMappings` are required: breakpoints are workspace-local paths, Xdebug
  reports VM paths, and the session translates both ways.
- The tunnel binds loopback on both ends: nothing is exposed to the LAN, no
  Windows firewall rule is needed. (The plugin's attach mode *can* bind
  `0.0.0.0` via the `host` parameter for setups where a tunnel is impossible —
  prefer the tunnel.)
- php74-fpm inside the lamp container (dev2 / old appwork) is a separate
  setup: the container has no Xdebug yet, and reaching the loopback tunnel
  from inside docker needs either sshd `GatewayPorts=clientspecified` on the
  VM or a direct `192.168.33.1` route with a non-loopback listener.
