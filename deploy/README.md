# deploy — 本机 DSH 部署胶水

这里放的是 `dsh.mergio.app` 这台机器上的启动脚本，不是 DSH 插件代码。
它们原先裸放在 `$HOME` 下、没有版本管理，改错了或换机就丢，所以收进仓库。

## 文件

| 文件 | 运行时位置 | 作用 |
| --- | --- | --- |
| `dsh-run.sh` | `~/dsh-run.sh` | 隧道实例：`dsh web --public-url https://dsh.mergio.app` |
| `dsh-lan-run.sh` | `~/dsh-lan-run.sh` | 局域网实例：绑定 LAN IP，供同网段设备访问 |
| `patch-pwa-manifest.sh` | `~/.dsh/patch-pwa-manifest.sh` | 幂等补丁：让 PWA manifest 带凭证拉取 |

`~/dsh-run.sh`、`~/dsh-lan-run.sh` 由 launchd 托管（`app.mergio.dsh`、`app.mergio.dsh-lan`），
plist 里写的是绝对路径，所以这两个位置必须保持存在。

## 为什么需要 patch-pwa-manifest.sh

`dsh.mergio.app` 整个域名在 Cloudflare Access 后面。浏览器取
`<link rel="manifest">` 时默认是**匿名请求**（规范如此），于是：

1. `GET /manifest.webmanifest` 无 cookie → 302 到 `mergio.cloudflareaccess.com/.../login`
2. Chrome 拿不到 JSON → `net::ERR_FAILED`
3. Chrome 认为站点没有 manifest → `installabilityErrors` 报
   `manifest-parsing-or-network-error` + `no-manifest`
4. 菜单里没有「安装」，只剩普通「创建快捷方式」

补丁把上游模板里的

```html
<link rel="manifest" href="./manifest.webmanifest" />
```

改成

```html
<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />
```

改的是 npx 缓存里的 `node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html`。
`dsh web` 每次请求都重读这个文件，所以**改完只要刷新页面，不用重启**。

修复后实测（真实域名 + 真实 CF 会话，CDP 直读 Chrome 判定）：
manifest 200 / 567 字节 / 0 解析错误，`installabilityErrors: []`，图标可正常解析。

## 注意

- **补丁在 npx 缓存里，`@deepseek-ai/dsh` 一升级就没了。** 两个启动脚本的等待循环里都会调用
  `patch-pwa-manifest.sh` 重新打，幂等、已打则跳过。它同时扫描所有
  `~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html`。
- 上游 bug 仍在（`deepseek-ai/deepseek-harness` 的 `apps/web/index.html`）。任何把 `dsh web`
  放 cookie 鉴权后面（CF Access / Basic Auth / SSO / 反代）的部署都会中招，值得提 PR。
- 备选方案（可与补丁并存）：在 CF Access 给 `/manifest.webmanifest`、`/icon-*.png`、
  `/apple-touch-icon.png`、`/favicon*.svg` 加 Bypass 策略，匿名也能取，最稳。
- manifest 的 `start_url` 是 `/`，仍受 CF Access + DSH 自身签名 cookie 保护。cookie 过期后
  点桌面图标会先落到 CF 登录页，登录后回到原路径。

## 安装 / 复原

```bash
ln -sf "$HOME/project/dsh-monitor/deploy/dsh-run.sh"            "$HOME/dsh-run.sh"
ln -sf "$HOME/project/dsh-monitor/deploy/dsh-lan-run.sh"        "$HOME/dsh-lan-run.sh"
ln -sf "$HOME/project/dsh-monitor/deploy/patch-pwa-manifest.sh" "$HOME/.dsh/patch-pwa-manifest.sh"
```

仓库目录若搬家，这三个 symlink 要跟着重建。
