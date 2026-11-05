/* ============================================================
   预加载脚本 —— 在渲染进程暴露安全的桥接 API
   ------------------------------------------------------------
   关键设计：把 window.fetch 替换为「代理 fetch」。
   渲染进程发往小宇宙的跨域请求，统统转到主进程执行 ——
   桌面端没有浏览器 CORS 限制，因此网页版做不到的接口这里都能用。
   第三方 / CDN 请求（如封面图、音频）保持原样直接走网络。
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

/* ---------- 小宇宙域名（走代理） ---------- */
const XYZ_HOSTS = [
  'api.xiaoyuzhoufm.com',
  'web-api.xiaoyuzhoufm.com',
  'podcaster-api.xiaoyuzhoufm.com',
  'www.xiaoyuzhoufm.com',
  'image.xyzcdn.net',
  'media.xyzcdn.net'
];

function shouldProxy(url) {
  try {
    const u = new URL(url, 'https://www.xiaoyuzhoufm.com');
    return XYZ_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

/* ---------- 代理 fetch ---------- */
async function proxyFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const method = init.method || (typeof input !== 'string' && input.method) || 'GET';

  // GET 且带 credentials 时用主进程 net.fetch；其余走通用代理
  const res = await ipcRenderer.invoke('net:fetch', {
    url,
    method,
    body: init.body,
    headers: init.headers
  });

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.status === 200 ? 'OK' : String(res.status),
    url,
    headers: {
      get: (k) => {
        const v = (res.json && res.json.__headers && res.json.__headers[k.toLowerCase()]);
        return v === undefined ? null : v;
      },
      has: () => false,
      forEach: () => {},
      entries: () => [][Symbol.iterator]()
    },
    text: async () => res.text || '',
    json: async () => res.json,
    clone: function () { return this; },
    arrayBuffer: async () => {
      const t = res.text || '';
      return new TextEncoder().encode(t).buffer;
    },
    body: null
  };
}

/* 包装原生 fetch：小宇宙域名走代理，其余直通 */
const nativeFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (shouldProxy(url)) return proxyFetch(input, init);
  return nativeFetch(input, init);
};

/* ---------- 暴露给页面使用的 API ---------- */
contextBridge.exposeInMainWorld('xyz', {
  isDesktop: true,

  /* 登录 */
  auth: {
    sendCode: (phone, areaCode) => ipcRenderer.invoke('auth:sendCode', { phone, areaCode }),
    login: (phone, code, areaCode) => ipcRenderer.invoke('auth:login', { phone, code, areaCode }),
    logout: () => ipcRenderer.invoke('auth:logout'),
    status: () => ipcRenderer.invoke('auth:status'),
    refresh: () => ipcRenderer.invoke('auth:refresh'),
    request: (method, p, body) => ipcRenderer.invoke('auth:request', { method, path: p, body })
  },

  /* 通用网络 */
  net: {
    fetch: (url, opts) => ipcRenderer.invoke('net:fetch', {
      url, method: (opts && opts.method) || 'GET', body: opts && opts.body, headers: opts && opts.headers
    }),
    buildId: () => ipcRenderer.invoke('net:buildId'),
    data: (pathname) => ipcRenderer.invoke('net:data', { pathname })
  },

  /* 应用信息与原生能力 */
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    message: (opts) => ipcRenderer.invoke('dialog:message', opts)
  },

  /* 主题同步到原生层（标题栏等） */
  setNativeTheme: (mode) => ipcRenderer.send('theme:set', mode)
});
