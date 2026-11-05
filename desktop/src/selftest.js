/* ============================================================
   启动自检 —— 由 main.js 在 app ready 后调用
   环境变量 XYZ_SELFTEST=1 时启用，结果写入 userData/selftest.json
   ============================================================ */

/* 该文件由 main.js 通过 eval 注入执行，可直接访问 main.js 作用域
   （app / net / apiRequest / sendSmsCode / ... 都在同一作用域内） */
module.exports = function runSelfTest(deps) {
  const { app, net, apiRequest, sendSmsCode, loginWithCode, refreshToken,
          saveTokens, loadTokens, TOKEN_FILE } = deps;
  const out = [];
  const log = (k, v) => {
    out.push(k + ': ' + JSON.stringify(v));
    console.log('[selftest] ' + k + ': ' + JSON.stringify(v));
  };

  return (async () => {
    try {
      log('electron 内置模块', {
        app: typeof app, net: typeof net,
        BrowserWindow: typeof deps.BrowserWindow, ipcMain: typeof deps.ipcMain
      });
    } catch (e) { log('内置模块 ERROR', String(e.message).slice(0, 120)); }

    try {
      log('userData 路径', app.getPath('userData'));
    } catch (e) { log('userData ERROR', String(e.message).slice(0, 80)); }

    /* 跨域代理 fetch —— 网页版做不到的事 */
    try {
      const url = await deps.dataUrl('/podcast/625635587bfca4e73e990703');
      const r = await apiRequest('GET', url, { plain: true });
      log('buildId', await deps.getBuildId());
      log('代理 fetch（跨域）', {
        ok: r.ok, status: r.status,
        hasPodcast: !!(r.json && r.json.pageProps && r.json.pageProps.podcast),
        name: r.json && r.json.pageProps && r.json.pageProps.podcast
          ? r.json.pageProps.podcast.title : null
      });
    } catch (e) { log('代理 fetch ERROR', String(e.message).slice(0, 140)); }

    /* 真实登录接口 1：发短信验证码 */
    try {
      const r = await sendSmsCode('13800138000', '+86');
      log('登录接口 sendCode', r);
    } catch (e) { log('sendCode ERROR', String(e.message).slice(0, 140)); }

    /* 真实登录接口 2：验证码登录（错误码能返回说明接口真在校验） */
    try {
      const r = await loginWithCode('13800138000', '000000', '+86');
      log('登录接口 loginWithCode', r);
    } catch (e) { log('loginWithCode ERROR', String(e.message).slice(0, 140)); }

    /* 凭证加解密往返 */
    try {
      const sample = { accessToken: 'AT_TEST_123', refreshToken: 'RT_TEST_456',
                       uid: 'u1', nickname: '测试', savedAt: Date.now() };
      saveTokens(sample);
      const back = loadTokens();
      log('凭证加解密往返', {
        roundtrip: !!(back && back.accessToken === sample.accessToken &&
                      back.nickname === sample.nickname),
        uid: back && back.uid,
        fileExists: require('fs').existsSync(TOKEN_FILE)
      });
      try { require('fs').unlinkSync(TOKEN_FILE); } catch (e) {}
    } catch (e) { log('凭证 ERROR', String(e.message).slice(0, 140)); }

    /* 未登录态下刷新 token 应安全失败 */
    try {
      const r = await refreshToken();
      log('token 刷新（未登录态）', r);
    } catch (e) { log('refreshToken ERROR', String(e.message).slice(0, 140)); }

    console.log('\n===== SELFTEST DONE =====\n' + out.join('\n') + '\n=====================\n');
    try {
      require('fs').writeFileSync(
        require('path').join(app.getPath('userData'), 'selftest.json'),
        JSON.stringify(out, null, 2));
    } catch (e) {}
  })();
};
