#!/usr/bin/env node
/**
 * selfcheck-chat —— 聊天窗的消息顺序（第 40 轮 #1）
 *
 * 他报的：「双击唤出的聊天窗口消息同步异常，表现为我刚刚发送的消息会插入在此前的对话之中」。
 *
 * 病根（改前）在 `ui/chat.js` 的 `openChat()`：
 *     `await chat.history()` 一回来就 appendChild 到**末尾**。
 * 他手快，历史还在路上（要读文件）就回车了 —— 那条新消息先落在列表里，
 * 历史回来了**追加在它后面**，于是新消息被夹在「—— 下面是你们之前聊的 ——」
 * 和一堆旧对话中间。窗口刚弹出来那几百毫秒最容易中，所以他说「双击唤出的时候」。
 *
 * ★ 这个自检**不是读源码数的** —— 它搭一个极简 DOM shim，把 `ui/chat.js`
 *   真的 import 进来跑，然后**量 cBody 里的真实顺序**。
 *
 * ★★ 而且它能**自己证明自己有用**：`--selftest` 会把产品代码改回改前的写法，
 *    然后要求自检**变红**。断言写错（比如永远拿到空串）会「全绿」——
 *    那种假绿比没有自检更危险，所以这道自验必须过。
 *
 * 三个场景（各自独立进程 —— 模块里的 `histLoaded` 是单例，混在一起就串了）：
 *   ok   —— 历史慢（200ms）时抢跑一条 → 抢跑那条必须排在历史**后面**
 *   fail —— 历史读失败 → 下次 openChat 必须**再试一次**（改前那个守卫从此永远为真）
 *   once —— 历史读成功过 → 再 openChat 不许重复拉
 *
 * 用法：
 *   node selfcheck-chat.cjs                  # 跑一遍，全绿才 0
 *   node selfcheck-chat.cjs --selftest       # 先突变自验，再跑一遍
 *
 * ⚠️⚠️ **别拿 `git show HEAD:src/renderer/ui/chat.js` 当红基线**（我试过，测不出来）。
 *    原因：这个仓库的工作树里压着**好几轮没提交的改动**，git 里的那份是**更早**的版本 ——
 *    它甚至连 `speak:say` 监听都还没有（那是上一轮补的），
 *    于是「抢跑的那条」压根不会进场，量出来的不是顺序错，是「没有这条」。
 *    ⇒ 「改前」指的是**工作树上一版**，不是 HEAD。要红的基准，用 `--mutate`。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const DEFAULT_TARGET = path.join('D:', 'AI_work', 'Git', 'src', 'renderer', 'ui', 'chat.js');
const UI_DIR = path.join('D:', 'AI_work', 'Git', 'src', 'renderer', 'ui');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   突变表 —— 每一条都必须让对应场景**变红**（见 --selftest）
   ============================================================ */
const MUTATIONS = {
  /** 改前：历史 append 到**末尾** */
  append: { from: 'body().prepend(frag)', to: 'body().appendChild(frag)', scene: 'ok' },
  /** 改前：拿「body 里有没有元素」当守卫（失败一次就永久锁死） */
  oldguard: { from: 'if (!histLoaded && !histLoading) {', to: 'if (!body().childElementCount) {', scene: 'fail' },
};

function applyMutation(code, kind) {
  const m = MUTATIONS[kind];
  if (!m) { console.error('不知道这个突变：' + kind); process.exit(2); }
  if (!code.includes(m.from)) {
    console.error('⚠ 突变点找不到了 —— 产品代码结构变了，去改 MUTATIONS：' + m.from);
    process.exit(2);
  }
  return code.split(m.from).join(m.to);
}

/* ============================================================
   极简 DOM shim —— 只实现 chat.js / host.js 真正用到的那一小撮
   ============================================================ */

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    parent: null,
    _cls: '',
    _text: '',
    _html: '',
    style: { setProperty() {} },
    dataset: {},
    disabled: false,
    value: '',
    onclick: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(n) { insertInto(this, n, false); return n; },
    prepend(n) { insertInto(this, n, true); return n; },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
  };
  Object.defineProperty(el, 'className', {
    get() { return this._cls; },
    set(v) { this._cls = String(v); this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this.children = []; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children = []; },
  });
  Object.defineProperty(el, 'childElementCount', { get() { return this.children.length; } });
  return el;
}

/**
 * DOM 的 appendChild/prepend 语义。
 * ⚠️ `prepend(fragment)` 是把 fragment 的孩子们**按原顺序**插到最前 ——
 *    本次修复就靠这条，shim 里写错了这自检就白测了。
 */
function insertInto(parent, node, atFront) {
  const list = node.__frag ? node.children.splice(0) : [node];
  for (const c of list) c.parent = parent;
  if (atFront) parent.children.unshift(...list);
  else parent.children.push(...list);
}

/**
 * 一条消息的文字**在子元素里**（`c-row > c-bub > span`），所以断言要递归取 ——
 * 只读顶层元素的 `textContent` 会永远拿到空串，那是假绿（我第一版就踩了）。
 */
const deepText = (el) => (el._text || '') + el.children.map(deepText).join('');

/** 只取「挂在 cBody 底下那一层」的元素（消息列表本身） */
const topLevel = (cBody) => cBody.children.map((c) => ({ cls: c._cls, text: deepText(c) }));

/* ============================================================
   一个场景
   ============================================================ */

async function runScene(scene, target, mutate) {
  let pass = 0;
  let fail = 0;
  const chk = (name, ok, detail) => {
    if (ok) { pass++; console.log('    ✓ ' + name); }
    else { fail++; console.log('    ✗ ' + name + (detail ? '   → ' + detail : '')); }
  };

  const cfg = {
    historyDelay: scene === 'ok' ? 200 : 0,
    historyMode: scene === 'fail' ? 'fail' : 'ok',
    historyCalls: 0,
    injectOnRegister: scene === 'ok',   // 注册 speak:say 的瞬间就抢跑一条
  };

  const HIST = [
    { role: 'user', content: '【旧】他星期一问的那句' },
    { role: 'ai', content: '【旧】她星期一答的那句' },
  ];
  const RUSH = '【抢跑】历史还在路上时她就说的这一句';

  /* ---- DOM ---- */
  const ids = {};
  for (const id of ['cBody', 'cInput', 'cClose', 'cSend', 'cClear']) ids[id] = makeEl('div');

  const documentStub = {
    body: makeEl('body'),
    documentElement: { style: { setProperty() {} } },
    fonts: { add() {}, delete() {}, ready: Promise.resolve() },
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => { const f = makeEl('#fragment'); f.__frag = true; return f; },
    getElementById: (id) => ids[id] || null,
    addEventListener() {},
    querySelector: () => null,
  };

  const handlers = {};
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    innerHeight: 560,
    yachiyo: {
      on(ev, fn) {
        (handlers[ev] || (handlers[ev] = [])).push(fn);
        if (ev === 'speak:say' && cfg.injectOnRegister) {
          // ★ 抢跑：历史还在飞，这句话先落地了
          setImmediate(() => handlers['speak:say'].forEach((f) => f(RUSH)));
        }
      },
      chat: {
        history() {
          cfg.historyCalls++;
          return new Promise((res, rej) => {
            setTimeout(() => {
              if (cfg.historyMode === 'fail') rej(new Error('读不了'));
              else res(HIST);
            }, cfg.historyDelay);
          });
        },
        send: async (t) => ({ ok: true, text: '答：' + t }),
        clear: async () => {},
        abort: async () => {},
      },
      cfg: {
        all: async () => ({ theme: 'light', petSize: 60, gazeFollowSec: 15 }),
        set: async () => {}, patch: async () => {},
      },
      ov: { open() {}, close() {}, closeKind() {} },
      win: { quit() {}, ignoreMouse() {} },
      ai: { ping: async () => ({}), models: async () => [] },
      usage: { get: async () => ({}) },
      font: { bytes: async () => new ArrayBuffer(0), list: async () => [] },
    },
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.FontFace = class { constructor() {} };
  // chat.js 顶层就 bootChat()，任何一路没兜住的 async 抛错都别把进程带走
  process.on('unhandledRejection', () => {});
  process.on('uncaughtException', () => {});

  /* ---- 把目标文件拿进来（要搬家的那份，两行相对 import 改写成绝对路径） ---- */
  let code = fs.readFileSync(target, 'utf8');
  if (mutate) code = applyMutation(code, mutate);

  const isRepoFile = path.resolve(target).toLowerCase() === path.resolve(DEFAULT_TARGET).toLowerCase();
  const base = (isRepoFile ? pathToFileURL(path.dirname(target) + path.sep).href
    : pathToFileURL(UI_DIR + path.sep).href);
  for (const rel of ['./icons.js', './host.js']) {
    code = code.split(`from '${rel}'`).join(`from '${base + rel.slice(2)}'`);
  }

  const tmp = path.join(os.tmpdir(), `yachiyo-selfcheck-chat-${process.pid}-${scene}.mjs`);
  fs.writeFileSync(tmp, code, 'utf8');

  const mod = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);

  /* ---- 等这一轮尘埃落定 ---- */
  await sleep(500);

  const cBody = ids.cBody;
  const rows = topLevel(cBody);

  if (scene === 'ok') {
    const idxRush = rows.findIndex((r) => r.text === RUSH);
    const idxHist1 = rows.findIndex((r) => r.text === HIST[0].content);
    const idxHist2 = rows.findIndex((r) => r.text === HIST[1].content);
    const idxSep = rows.findIndex((r) => r.text && r.text.indexOf('下面是你们之前聊的') >= 0);

    chk('历史两条都在列表里', idxHist1 >= 0 && idxHist2 >= 0, JSON.stringify(rows.map((r) => r.text)));
    chk('抢跑的那一条也在列表里', idxRush >= 0, JSON.stringify(rows.map((r) => r.text)));
    chk(
      '★ 抢跑的消息排在历史**后面**（改前会被历史压到前面去）',
      idxRush >= 0 && idxRush > idxHist1 && idxRush > idxHist2,
      `抢跑@${idxRush} vs 历史@${idxHist1},${idxHist2}`
    );
    chk('历史两条自己保持原顺序', idxHist1 >= 0 && idxHist2 > idxHist1, `@${idxHist1},${idxHist2}`);
    chk('「下面是你们之前聊的」在最前面', idxSep === 0, `@${idxSep}`);
  }

  if (scene === 'fail') {
    chk('开机时拉过一次历史', cfg.historyCalls === 1, String(cfg.historyCalls));
    await mod.openChat();
    await sleep(120);
    /*
     * ★ 改前的守卫是 `if (!body().childElementCount)` ——
     *   读失败时 note() 往 body 里塞了一条错误提示，`childElementCount` 从此 > 0，
     *   于是**这一辈子都不会再重试**。这里就该看到 2。
     */
    chk('★ 失败之后再开窗会**重试**（改前那个守卫会永久锁死）', cfg.historyCalls >= 2, String(cfg.historyCalls));
  }

  if (scene === 'once') {
    chk('开机时拉过一次历史', cfg.historyCalls === 1, String(cfg.historyCalls));
    await mod.openChat();
    await mod.openChat();
    await sleep(120);
    chk('★ 成功之后反复开窗**不重复拉**', cfg.historyCalls === 1, String(cfg.historyCalls));
    chk('没有把历史插两遍', cBody.children.filter((r) => deepText(r) === HIST[0].content).length === 1);
  }

  console.log(`  ${scene}: ${pass} 通过 / ${fail} 失败`);
  return fail === 0;
}

/* ============================================================
   主控
   ============================================================ */

(async () => {
  const posArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const target = posArg ? path.resolve(posArg) : DEFAULT_TARGET;

  const arg = (name) => {
    const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
    return hit ? hit.split('=')[1] : null;
  };

  /* 子进程模式：只跑一个场景 */
  const scene = arg('scene');
  if (scene) {
    const ok = await runScene(scene, target, arg('mutate'));
    process.exit(ok ? 0 : 1);
  }

  console.log('selfcheck-chat —— 聊天窗消息顺序');
  console.log('测的是：' + target);
  console.log('');

  /* ★ 先突变自验：断言必须抓得住改前的写法，否则后面那个"全绿"不值钱 */
  if (process.argv.includes('--selftest')) {
    console.log('■ 突变自验（每一处都必须变红）');
    let mutOk = true;
    for (const [kind, m] of Object.entries(MUTATIONS)) {
      console.log('  ── 突变 ' + kind + ' → 场景 ' + m.scene + '（期望变红）──');
      let status = 0;
      try {
        execFileSync(process.execPath, [__filename, target, '--scene=' + m.scene, '--mutate=' + kind], { stdio: 'inherit' });
      } catch (e) {
        status = typeof e.status === 'number' ? e.status : -1;
      }
      if (status === 2) {
        console.log('  ✗ 突变点没找到（产品代码结构变了）—— 去改 MUTATIONS');
        mutOk = false;
      } else if (status === 1) {
        console.log('  ✓ ' + kind + ' 如期变红');
      } else {
        console.log('  ✗ ' + kind + ' **还是绿的** —— 这个断言是摆设');
        mutOk = false;
      }
    }
    console.log('');
    if (!mutOk) { console.log('✗ 突变没变红，自检不可信 —— 后面的结果不用看了'); process.exit(1); }
    console.log('★ 突变全部如期变红：断言真的在管这件事');
    console.log('');
  }

  let allOk = true;
  for (const s of ['ok', 'fail', 'once']) {
    console.log('  ── 场景 ' + s + ' ──');
    try {
      execFileSync(process.execPath, [__filename, target, '--scene=' + s], { stdio: 'inherit' });
    } catch {
      allOk = false;
    }
  }
  console.log('');
  console.log(allOk ? '★ 全绿' : '✗ 有红');
  process.exit(allOk ? 0 : 1);
})();
