/**
 * 端到端探针 · 开机自启 + 打错字
 *
 * 这两条都有一个"在 node 里看不出来"的地方：
 *   · 自启那条命令里 `process.execPath` 在 node 下是 **node.exe**，
 *     只有在 electron 里跑才是 electron.exe —— 在 node 里验等于没验
 *   · 打错字在**渲染层**（气泡），node 里根本没有 DOM
 *
 * ⚠️ 自启那条会**真的往注册表写**。探针跑完会**恢复原样**
 *    （跑之前读下来，跑完写回去 / 删掉）—— 不能因为跑个探针
 *    就把他机器的开机启动项改了。
 *
 * 跑法：node scripts/probe-autostart.cjs
 */

'use strict';

const { spawn, execSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9348;
const HOME = path.join(ROOT, '_probe-as-home');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'YachiyoPet';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { res, rej } = this.pend.get(m.id);
        this.pend.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static async attach(match) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(match));
    if (!p) throw new Error('没找到 ' + match);
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/** 读注册表里那条（没有返回 ''） */
function regRead() {
  try {
    const out = execFileSync('reg.exe', ['query', RUN_KEY, '/v', RUN_NAME],
      { encoding: 'utf8', windowsHide: true });
    const m = out.split(/\r?\n/).find((l) => l.includes(RUN_NAME));
    if (!m) return '';
    const parts = m.trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join('  ').trim() : '';
  } catch { return ''; }   // 项不存在时 reg.exe 返回非 0，是正常情况
}

/* ── 隔离目录 ── */
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'data', 'state'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  autostart: false, sound: false, moveEnabled: false, backupDaily: false,
  // ★ 口误拉满，好验；真机上他自己设的是 5
  typo: true, typoRate: 100, typoHoldMs: 800,
  memShort: false, apiKey: '',
}, null, 2), 'utf8');

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  // ⚠️ 先把原来那条存下来 —— 跑完要恢复
  const ORIGINAL = regRead();
  console.log(`\n  （跑之前注册表里那条：${ORIGINAL || '（没有）'}）\n`);

  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(600);

  const child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: '60000', YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let main = null;
  for (let i = 0; i < 50 && !main; i++) {
    await sleep(500);
    try { main = await CDP.attach('index.html'); } catch { /* 还没起来 */ }
  }
  if (!main) { child.kill(); throw new Error('Electron 没起来'); }
  await sleep(3000);

  try {
    /* ── ① 打错字 ── */
    console.log('【口误 · 只改气泡上显示的字】');
    // 让气泡直接说一句确定的文本（绕过 AI，专注验口误本身）
    await main.evalJs(`
      window.__t = document.getElementById('bText');
      return 1;`);

    // 走真路径：主进程推 speak:say → 气泡 showBubble → startTypo
    // ⚠️ typoRate=100 保证必中
    const wrongShown = await main.evalJs(`
      const tx = document.getElementById('bText');
      const el = document.getElementById('bubble');
      // 手动触发一次（跟主进程推 speak:say 走同一个函数）
      const mod = await import('./ui/bubble.js');
      mod.showBubble('今天天气不错，我想出去走走');
      await new Promise(r => setTimeout(r, 60));
      return { shown: tx.textContent, open: el.classList.contains('open') };`);
    ok(wrongShown.open === true, '气泡开了', '');
    ok(wrongShown.shown !== '今天天气不错，我想出去走走',
      '★ 一开始显示的是**打错的**版本（口误真的下手了）', wrongShown.shown);

    await sleep(1300);
    const fixed = await main.evalJs(`return document.getElementById('bText').textContent;`);
    ok(fixed === '今天天气不错，我想出去走走',
      '★★ 隔一会儿自己改回来了', `现在是「${fixed}」`);

    // 记录里必须是正确的
    const chatFile = path.join(HOME, 'data', 'chat.jsonl');
    const chatTxt = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8') : '';
    ok(!chatTxt.includes(wrongShown.shown.slice(0, 4)) || wrongShown.shown === fixed,
      '★ 聊天记录里没被写进错字（只动显示）', '');

    /* ── ② 数字 / 英文 / 方括号里不下手 ── */
    const safe = await main.evalJs(`
      const m = await import('./ui/typo.js');
      return {
        bracket: m.pickEdit('[心情 好] 他说他今天不来了', () => 0),
        number: m.pickEdit('12345 67890', () => 0),
        english: m.pickEdit('hello world abc', () => 0),
      };`);
    ok(safe.bracket && !['心', '情', '好'].some((c) => safe.bracket.wrong.includes(c)),
      '★ 不下手到方括号里的字', JSON.stringify(safe.bracket));
    ok(safe.number === null, '★ 纯数字不下手', String(safe.number));
    ok(safe.english === null, '★ 纯英文不下手', String(safe.english));

    /* ── ③ 开机自启 ── */
    console.log('\n【开机自启】');
    const as = await main.evalJs(`
      const c = await window.yachiyo.cfg.all();
      return { autostart: c.autostart };`);
    ok(as.autostart === false, '  配置里默认是关着的', String(as.autostart));

    // 勾上 —— 走真实的 IPC 路径（跟他在设置面板里点那一下一样）
    await main.evalJs(`return window.yachiyo.cfg.set('autostart', true);`);
    await sleep(900);

    const written = regRead();
    console.log(`  注册表里现在是：${written || '（还是空的）'}`);
    ok(!!written, '★ 勾上之后注册表里真的写了一条', written);
    ok(/electron\.exe/i.test(written) || /Yachiyo/i.test(written),
      '★ 写的是**可执行文件**，不是 node.exe（在 node 里跑这条命令会写错）', '');
    ok(/AI_work/i.test(written),
      '★ 命令里带上了**工程路径**（不带的话开机只会弹一个空白 Electron）', '');

    // 取消
    await main.evalJs(`return window.yachiyo.cfg.set('autostart', false);`);
    await sleep(900);
    const after = regRead();
    ok(after === '', '★ 取消之后那条被删掉了', after || '（空）');

  } finally {
    try { child.kill(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }

    /* ⚠️ 恢复原样 —— 探针不能改他的开机启动项 */
    try {
      if (ORIGINAL) {
        execFileSync('reg.exe', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', ORIGINAL, '/f'],
          { stdio: 'ignore', windowsHide: true });
        console.log(`\n  （已经把他原来那条恢复回去：${ORIGINAL}）`);
      } else if (regRead()) {
        // ⚠️ 只有**真的有**才去删 —— reg delete 对不存在的项会返回非 0，
        //    那不是错，但会让人以为恢复失败。第一版就是这么虚惊一场。
        execFileSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'],
          { stdio: 'ignore', windowsHide: true });
        console.log('\n  （注册表恢复成原来的「没有」状态）');
      } else {
        console.log('\n  （注册表本来就是干净的，不用恢复）');
      }
    } catch { console.log('\n  ⚠️ 恢复注册表时出错，请手动检查 Run 项'); }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e.message); process.exit(1); });
