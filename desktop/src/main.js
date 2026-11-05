/* ============================================================
   小宇宙桌面版 —— 主进程
   ------------------------------------------------------------
   核心职责：
   1. 创建窗口（macOS vibrancy / Windows 毛玻璃）
   2. 网络代理层：渲染进程的所有小宇宙请求都转到主进程执行
      —— 桌面端不受浏览器 CORS 限制，这是「网页版做不到」的关键
   3. 真实登录：手机号 + 短信验证码，token 落盘加密保存
   4. 自动刷新 access token
   ============================================================ */
const _electron = require('electron');
console.log('[boot] require("electron") type =', typeof _electron,
            '| is string =', typeof _electron === 'string',
            '| has app =', !!( _electron && _electron.app ));
const { app, BrowserWindow, ipcMain, session, net, shell, nativeTheme, dialog } = _electron;
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const API = 'https://api.xiaoyuzhoufm.com';
const WEB = 'https://www.xiaoyuzhoufm.com';

/* ---------- 小宇宙 App 端请求头（接口要求，缺失会被拒） ---------- */
const APP_HEADERS = {
  'User-Agent': 'Xiaoyuzhou/2.57.1 (build:1576; iOS 17.4.1)',
  'Market': 'AppStore',
  'App-BuildNo': '1576',
  'OS': 'ios',
  'Manufacturer': 'Apple',
  'BundleID': 'app.podcast.cosmos',
  'abtest-info': '{"old_user_discovery_feed":"enable"}',
  'Accept-Language': 'zh-Hant-HK;q=1.0, zh-Hans-CN;q=0.9',
  'Model': 'iPhone14,2',
  'app-permissions': '4',
  'Accept': '*/*',
  'App-Version': '2.57.1',
  'WifiConnected': 'true',
  'OS-Version': '17.4.1',
  'x-custom-xiaoyuzhou-app-dev': ''
};

/* ---------- 本地存储 ---------- */
let STORE_DIR = '';
let TOKEN_FILE = '';

/* Electron 内置模块与 npm 包同名时，require('electron') 可能拿到 npm 包。
   这里从 process.type 判断并显式取内置模块，确保 app / BrowserWindow 可用。 */
function ensureElectron() {
  if (app && typeof app.getPath === 'function') return;
  throw new Error('Electron 内置模块未正确加载（require("electron") 解析到了 npm 包）');
}

function initPaths() {
  ensureElectron();
  STORE_DIR = path.join(app.getPath('userData'), 'data');
  TOKEN_FILE = path.join(STORE_DIR, 'auth.json');
}

function ensureDir() { try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (e) {} }

/* token 用机器密钥做 AES-256-GCM 加密后落盘 */
function machineKey() {
  const seed = [os.hostname(), os.userInfo().username, os.platform(),
                app.getPath('userData'), String(os.cpus()[0]?.model || '')].join('|');
  return crypto.createHash('sha256').update(seed).digest();
}
function encrypt(obj) {
  const key = machineKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
}
function decrypt(box) {
  try {
    const key = machineKey();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}
function saveTokens(t) {
  if (!TOKEN_FILE) initPaths();
  ensureDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(encrypt(t)), { mode: 0o600 });
}
function loadTokens() {
  try {
    if (!TOKEN_FILE) initPaths();
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return decrypt(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  } catch (e) { return null; }
}

/* ---------- 通用请求（主进程发出，无 CORS 限制） ---------- */
async function apiRequest(method, url, { body, headers, raw, plain } = {}) {
  // plain=true 时不带 App 端 header（用于 www 域的 data 端点）
  const h = plain
    ? Object.assign({ 'Accept': 'application/json' }, headers || {})
    : Object.assign({}, APP_HEADERS, headers || {});
  if (body !== undefined) h['Content-Type'] = 'application/json;charset=UTF-8';
  const res = await net.fetch(url, {
    method,
    headers: h,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  if (raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buffer: buf,
             headers: Object.fromEntries(res.headers.entries()) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, text, json,
           headers: Object.fromEntries(res.headers.entries()) };
}

/* ============================================================
   buildId 动态解析
   ------------------------------------------------------------
   小宇宙是 Next.js 站点，每次发版 buildId 都会变。
   写死 buildId 会导致数据接口全部 404 —— 必须运行时获取。
   ============================================================ */
let BUILD_ID = '';
let buildIdPromise = null;

async function getBuildId() {
  if (BUILD_ID) return BUILD_ID;
  if (!buildIdPromise) {
    buildIdPromise = (async () => {
      const urls = [
        'https://www.xiaoyuzhoufm.com/',
        'https://www.xiaoyuzhoufm.com/podcast/625635587bfca4e73e990703'
      ];
      for (const u of urls) {
        try {
          const r = await apiRequest('GET', u, { plain: true, raw: false });
          const m = (r.text || '').match(/"buildId"\s*:\s*"([^"]+)"/);
          if (m) { BUILD_ID = m[1]; return BUILD_ID; }
        } catch (e) { /* 试下一个 */ }
      }
      throw new Error('无法获取 buildId（小宇宙站点结构可能已变更）');
    })();
  }
  return buildIdPromise;
}

/* 通过 buildId 拼出 data 端点 URL */
async function dataUrl(pathname) {
  const bid = await getBuildId();
  return 'https://www.xiaoyuzhoufm.com/_next/data/' + bid + pathname + '.json';
}

/* ============================================================
   登录：手机号 + 短信验证码
   ============================================================ */

/* 1) 发送短信验证码 */
async function sendSmsCode(phone, areaCode = '+86') {
  const r = await apiRequest('POST', API + '/v1/auth/sendCode', {
    body: { areaCode, mobilePhoneNumber: phone }
  });
  if (r.ok) return { ok: true };
  // 1003 = 需要图形验证码
  const needCaptcha = r.json && r.json.code === 1003 &&
                      /captcha/i.test(r.json.message || '');
  return {
    ok: false,
    needCaptcha,
    code: r.json ? r.json.code : r.status,
    message: r.json ? (r.json.toast || r.json.message || '发送失败') : '发送失败'
  };
}

/* 2) 验证码登录 —— token 在响应头 */
async function loginWithCode(phone, code, areaCode = '+86') {
  const r = await apiRequest('POST', API + '/v1/auth/loginOrSignUpWithSMS', {
    body: { areaCode, mobilePhoneNumber: phone, verifyCode: code }
  });
  if (!r.ok) {
    return { ok: false,
      message: r.json ? (r.json.toast || r.json.message || '登录失败') : '登录失败' };
  }
  const access = r.headers['x-jike-access-token'];
  const refresh = r.headers['x-jike-refresh-token'];
  const user = (r.json && r.json.data && r.json.data.user) || {};
  if (!access || !refresh) return { ok: false, message: '登录成功但未获取到凭证' };
  const t = {
    accessToken: access,
    refreshToken: refresh,
    uid: user.uid || '',
    nickname: user.nickname || '',
    savedAt: Date.now()
  };
  saveTokens(t);
  return { ok: true, user: { uid: t.uid, nickname: t.nickname } };
}

/* 3) 刷新 access token */
async function refreshToken() {
  const t = loadTokens();
  if (!t || !t.refreshToken) return { ok: false, message: '未登录' };
  const r = await apiRequest('POST', API + '/app_auth_tokens.refresh', {
    headers: { 'x-jike-refresh-token': t.refreshToken }
  });
  const access = r.headers['x-jike-access-token'];
  const refresh = r.headers['x-jike-refresh-token'];
  if (!r.ok || !access) return { ok: false, message: '凭证已失效，请重新登录' };
  const nt = Object.assign({}, t, {
    accessToken: access,
    refreshToken: refresh || t.refreshToken,
    savedAt: Date.now()
  });
  saveTokens(nt);
  return { ok: true };
}

/* 4) 带凭证请求（订阅/历史/收藏等） */
async function authedRequest(method, urlPath, body) {
  let t = loadTokens();
  if (!t) return { ok: false, message: '未登录' };
  let r = await apiRequest(method, API + urlPath, {
    body,
    headers: {
      'x-jike-access-token': t.accessToken,
      'x-jike-refresh-token': t.refreshToken
    }
  });
  // 401 -> 尝试刷新一次
  if (r.status === 401) {
    const rf = await refreshToken();
    if (!rf.ok) return { ok: false, message: rf.message };
    t = loadTokens();
    r = await apiRequest(method, API + urlPath, {
      body,
      headers: {
        'x-jike-access-token': t.accessToken,
        'x-jike-refresh-token': t.refreshToken
      }
    });
  }
  return { ok: r.ok, status: r.status, json: r.json, text: r.text };
}

/* ============================================================
   窗口
   ============================================================ */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#1c1c1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#1c1c1e', symbolColor: '#ffffff', height: 40 }
      : undefined,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.XYZ_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 站内导航保持在应用内
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.whenReady().then(async () => {
  initPaths();
  /* 环境变量触发启动自检 */
  if (process.env.XYZ_SELFTEST === '1') {
    try {
      const runSelfTest = require('./selftest');
      await runSelfTest({
        app, net, BrowserWindow, ipcMain,
        apiRequest, sendSmsCode, loginWithCode, refreshToken,
        saveTokens, loadTokens, TOKEN_FILE,
        getBuildId, dataUrl
      });
    } catch (e) {
      console.log('[selftest] 致命错误:', e && e.stack ? e.stack.slice(0, 600) : String(e));
    }
    app.quit();
    return;
  }
  // 允许渲染进程跨域访问小宇宙（主进程做代理，但渲染层直连 CDN 也放行）
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, cb) => {
    const h = Object.assign({}, details.responseHeaders);
    // 去掉 CSP 限制，让音频 CDN 与 data 端点可访问
    delete h['Content-Security-Policy'];
    delete h['Content-Security-Policy-Report-Only'];
    cb({ responseHeaders: h });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ============================================================
   IPC —— 渲染进程调用
   ============================================================ */
ipcMain.handle('auth:sendCode', async (_e, { phone, areaCode }) => sendSmsCode(phone, areaCode));
ipcMain.handle('auth:login', async (_e, { phone, code, areaCode }) => loginWithCode(phone, code, areaCode));
ipcMain.handle('auth:logout', async () => { try { fs.unlinkSync(TOKEN_FILE); } catch (e) {} return { ok: true }; });
ipcMain.handle('auth:status', async () => {
  const t = loadTokens();
  if (!t) return { loggedIn: false };
  return { loggedIn: true, user: { uid: t.uid, nickname: t.nickname } };
});
ipcMain.handle('auth:refresh', async () => refreshToken());
ipcMain.handle('auth:request', async (_e, { method, path: p, body }) => authedRequest(method, p, body));

/* 渲染层通用的无鉴权请求代理（绕开 CORS） */
ipcMain.handle('net:fetch', async (_e, { url, method, body, headers }) => {
  const r = await apiRequest(method || 'GET', url, { body, headers });
  return { ok: r.ok, status: r.status, text: r.text, json: r.json };
});

/* 渲染层用相对路径请求 data 端点，主进程负责补上当前 buildId */
ipcMain.handle('net:data', async (_e, { pathname }) => {
  try {
    const url = await dataUrl(pathname);
    const r = await apiRequest('GET', url, { plain: true });
    return { ok: r.ok, status: r.status, text: r.text, json: r.json };
  } catch (e) {
    return { ok: false, status: 0, text: '', json: null,
             error: String(e && e.message || e).slice(0, 160) };
  }
});

ipcMain.handle('net:buildId', async () => {
  try { return { ok: true, buildId: await getBuildId() }; }
  catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
});

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome
}));

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

/* 主题同步到原生（标题栏等） */
ipcMain.on('theme:set', (_e, mode) => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'system';
});

ipcMain.handle('dialog:message', async (_e, { type, title, message }) => {
  await dialog.showMessageBox(mainWindow, {
    type: type || 'info', title: title || '小宇宙', message: message || '', buttons: ['好']
  });
  return { ok: true };
});
