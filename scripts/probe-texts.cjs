/**
 * 探针：设置面板的**文字**到底渲染成什么样了（逐页打印，人工核对用）。
 *
 * 为什么单独搞一个：`probe-design` 验的是"接线通不通"，
 * 这个验的是"**改了标签之后，面板上真的是新文案吗**"——
 * 他 2026-10-13 报「文字怎么都没改」，需要眼见为实。
 *
 * 跑法：node scripts/probe-texts.cjs
 */
'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), 'yachiyo-texts-probe');
const PORT = 9396;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process electron,Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const list = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

async function connect(t, tries = 6) {
  const url = t && t.webSocketDebuggerUrl;
  let ws = null, last = null;
  for (let i = 0; i < tries; i++) {
    try {
      ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        setTimeout(() => rej(new Error('ws timeout')), 4000);
      });
      last = null; break;
    } catch (e) { last = e; ws = null; await sleep(800); }
  }
  if (!ws) throw new Error('连不上：' + (last && last.message));
  const pend = new Map(); let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  return async (ex) => {
    const id = ++seq;
    const p = new Promise((r) => pend.set(id, r));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: ex, awaitPromise: true, returnByValue: true } }));
    const r = await p;
    return r.result && r.result.exceptionDetails ? { __err: String(r.result.exceptionDetails.exception.description).slice(0, 200) }
      : (r.result && r.result.result ? r.result.result.value : undefined);
  };
}

async function main() {
  killAll();
  await sleep(700);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const child = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, windowsHide: true });
  let mainT = null;
  for (let i = 0; i < 25 && !mainT; i++) {
    await sleep(900);
    mainT = (await list()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  }
  if (!mainT) { console.log('✗ 起不来'); process.exit(1); }
  const M = await connect(mainT);
  await sleep(1500);
  await M(`window.yachiyo.ov.open('panel', {})`);

  let pt = null;
  for (let i = 0; i < 15 && !(pt && pt.webSocketDebuggerUrl); i++) {
    await sleep(700);
    pt = (await list()).find((t) => t.type === 'page' && t.url.includes('panel.html'));
  }
  const P = await connect(pt);
  await sleep(1500);

  const PAGES = [['habit', '习惯'], ['bubble', '对话框'], ['weather', '天气'], ['ai', 'AI 接入'], ['adv', '高级']];
  for (const [k, name] of PAGES) {
    await P(`(() => { const n=[...document.querySelectorAll('#navs .nav')].find(x=>x.dataset.k==='${k}'); if(n) n.click(); })()`);
    await sleep(1100);
    const d = await P(`(() => {
      const main = document.getElementById('pMain');
      return {
        title: (main.querySelector('h2')||{}).textContent || '',
        desc: (main.querySelector('.desc')||{}).textContent || '',
        groups: [...main.querySelectorAll('.group > .g-title')].map(x => x.textContent.trim()),
        labels: [...main.querySelectorAll('.row .label')].map(x => (x.firstChild && x.firstChild.textContent || '').trim()).filter(Boolean),
      };
    })()`);
    console.log('');
    console.log('【' + name + '】' + d.title);
    console.log('  介绍：' + d.desc);
    console.log('  分组：' + d.groups.join(' / '));
    console.log('  标签：' + d.labels.join(' · '));
  }

  try { child.kill(); } catch { }
  await sleep(800);
  killAll();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  process.exit(0);
}

main().catch((e) => { console.error('炸了：' + e.message); killAll(); process.exit(1); });
