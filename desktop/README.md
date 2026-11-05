# 小宇宙 · 桌面版

小宇宙播客客户端的桌面程序版 —— **Windows `.exe`** / **macOS `.dmg`**。

与网页版最大的区别：**桌面端由主进程直连小宇宙官方接口，不受浏览器跨域限制**，因此可以实现网页版做不到的**真实账号登录**。

## 下载

| 平台 | 文件 |
|---|---|
| Windows (x64) | `小宇宙-1.0.0-x64.exe`（安装包 / 免安装版） |
| macOS Intel | `小宇宙-1.0.0-x64.dmg` |
| macOS Apple Silicon | `小宇宙-1.0.0-arm64.dmg` |

> macOS 首次打开可能提示「无法验证开发者」，在「系统设置 → 隐私与安全性」中点击「仍要打开」即可。

## 真实登录

桌面版使用**手机号 + 短信验证码**登录小宇宙官方账号：

```
输入手机号 → 获取验证码 → 填写短信码 → 登录
```

实现要点：

- 请求由 **Electron 主进程**发出（`net.fetch`），不受浏览器 CORS 限制
- 使用小宇宙 App 端协议头（`User-Agent` / `Market` / `App-Version` / `BundleID` 等），官方接口校验通过
- 凭证 `x-jike-access-token` / `x-jike-refresh-token` 取自**响应头**
- 凭证经 **AES-256-GCM** 加密后落盘（密钥由机器信息派生），不进 `localStorage`、不上传
- access token 过期时自动用 refresh token 续期，续期失败才要求重新登录

### 为什么不用「扫码登录」

小宇宙网页版的扫码走**微信 JS SDK**，桌面浏览器不可用；App 端的扫码接口需要 `captchaVerifyParam`（图形验证码票据），该票据由 App 内部的滑块/点选风控流程产生，网页与桌面端都难以稳定复现。手机号验证码是官方公开且稳定的路径。

## 为什么不需要「部署代理」

网页版想调小宇宙的认证接口，必须有人转发请求 —— 因为 `api.xiaoyuzhoufm.com` 与 `web-api.xiaoyuzhoufm.com` **完全不返回 CORS 头**（OPTIONS 预检返回 204，但无 `Access-Control-Allow-Origin`），浏览器直接 `fetch` 必然失败。

于是常见想法是「在 GitHub 上部署个代理」。这里要说清楚：

| 方案 | 能否做常驻代理 | 原因 |
|---|---|---|
| GitHub Pages | ❌ | 纯静态托管，没有服务端运行时 |
| GitHub Actions | ❌ 不适合 | 单次运行有硬性时长上限，且每次扫码都触发一次 workflow 不现实 |
| **桌面版主进程** | ✅ | **Electron 主进程直接发 HTTP 请求，本来就没有 CORS 限制** |

**结论：转成桌面程序后，代理这一层直接消失了。** 请求从主进程发出，与浏览器同源策略无关。

这也是从网页版转向桌面版最大的收益 —— 除了能真实登录，还顺带解决了：
- `image.xyzcdn.net` 在部分网络下直连不稳（走主进程可复用系统代理）
- `buildId` 每次发版都会变（主进程运行时解析，自动适配，见下）

### 如果仍需要 Web 版 + 真实登录

那就得有一个真正的服务端。推荐 **Cloudflare Workers**（免费额度足够，跨域由 Worker 自己控制），把 Worker 代码放 GitHub、用 CI 自动部署即可 —— 但那是「用 GitHub 托管代码」，不是「用 GitHub 跑代理」。

## buildId 动态解析

小宇宙是 Next.js 站点，`/_next/data/{buildId}/...` 里的 buildId **每次发版都会变**。写死会导致所有数据接口 404。

桌面版由主进程在运行时从首页解析当前 buildId 并缓存：

```
GET https://www.xiaoyuzhoufm.com/  →  "buildId":"xxxx"
```

网页版则保留内置值 + 自动回落到网页源。

## 网络代理层

`electron/preload.js` 注入了一层 **代理 fetch**：发往小宇宙域名的请求统统转到主进程执行，其余（封面图、音频 CDN）保持直连。

这也顺带解决了另一个问题：小宇宙的 `image.xyzcdn.net` 在部分网络下直连不稳定，走主进程可以复用系统代理设置。

## 开发

```bash
npm install
npm start              # 开发模式
npm run build:win      # 打 Windows exe
npm run build:mac      # 打 macOS dmg（需在 macOS 上执行）
```

### 目录

```
electron/
  main.js       主进程：窗口、网络代理、登录、凭证加密存储
  preload.js    预加载：注入代理 fetch + 暴露安全 API
renderer/
  index.html    渲染层（单文件应用）
build/          图标资源
.github/workflows/build.yml   CI：Windows 出 exe，macOS 出 dmg
```

### 跨平台构建

macOS 的 `.dmg` **必须在 macOS 上构建**（Apple 的签名与 dmg 工具链限制）。仓库内置 GitHub Actions 工作流：

- `windows-latest` runner → `.exe`
- `macos-latest` runner → `.dmg`（Intel + Apple Silicon）

打 `v*` tag 会触发构建并自动创建 Release，产物含 SHA-256 校验和。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Electron 32 | 一套代码同时产出 exe 与 dmg，Chromium 内核保证 Web 兼容性 |
| 网络 | 主进程 `net.fetch` | 绕开浏览器 CORS，是真实登录的前提 |
| 凭证 | AES-256-GCM + 机器派生密钥 | 明文 token 落盘是安全隐患 |
| 打包 | electron-builder | nsis（Windows）/ dmg（macOS）原生安装体验 |

## 致谢与声明

- 数据与音频来自 [小宇宙](https://www.xiaoyuzhoufm.com) 公开接口，版权归原作者
- 本项目为技术演示，非小宇宙官方应用
- 音频版权归各播客节目原作者所有
