#!/usr/bin/env node
/**
 * selfcheck-round40 —— 第 40 轮那五条的断言（#2 #5 #6 #7）
 *
 *   #2 聊天窗文字可复制          → 解析 style.css 的规则，量 .c-bub 里有没有 user-select:text
 *   #5 托盘单击不再隐藏/显示桌宠   → **stub 掉 electron，真的跑一遍 tray.create()**，数它注册了哪些事件
 *   #6 眼动跟随改为「互动后 N 秒」 → ① config 默认值真读一遍 ② app.js 的门控是静态检查（见下）
 *   #7 拖动放下的台词已删          → 剥掉注释后在 app.js 里找那句 speak
 *
 * ⚠️ 诚实标注两条的**强度**：
 *    · #5 是**行为级**（真跑产品函数，事件名一个个数出来）
 *    · #2 是**规则级**（真解析 CSS，定位到 .c-bub 这条规则里，不是全文 grep）
 *    · #6 / #7 是**静态**检查 —— 它们住在渲染层的 DOM 回调里，纯 node 起不来。
 *      真正的行为验证要起真机（`probe-gaze-gate.cjs` 那类），别把静态当行为。
 *
 * 用法：node selfcheck-round40.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.join('D:', 'AI_work', 'Git');
const P = (...s) => path.join(REPO, ...s);

let pass = 0;
let fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '   → ' + detail : '')); }
};

const read = (rel) => fs.readFileSync(P(...rel.split('/')), 'utf8');

/** 剥掉注释 —— 不然我自己写在注释里的「原来那句 speak('嘿咻…')」会把断言变成假红 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 把一份 CSS 拆成 [{sel, body}]（够用就行，不追求完整 CSS 语法） */
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  return out;
}

console.log('selfcheck-round40 —— 第 40 轮的五条');
console.log('');

/* ============================================================
   #2 聊天窗文字可复制
   ============================================================ */
console.log('── #2 聊天窗文字可复制 ──');
{
  const rules = cssRules(read('src/renderer/style.css'));

  // 前提：全局那条 `user-select:none` 还在（那是给桌宠本体用的，别被谁顺手删了）
  const globalNone = rules.some((r) => /html\s*,\s*body|^html|^body/.test(r.sel) && /user-select\s*:\s*none/.test(r.body));
  chk('全局 user-select:none 还在（桌宠本体不该能选字）', globalNone);

  const bub = rules.filter((r) => r.sel.split(',').map((s) => s.trim()).includes('.c-bub'));
  chk('.c-bub 规则找得到', bub.length > 0);
  chk(
    '★ .c-bub 里开了 user-select:text（她说的每一条消息）',
    bub.some((r) => /(^|[^-])user-select\s*:\s*text/.test(r.body)),
    bub.map((r) => r.body.trim().slice(0, 60)).join(' | ')
  );

  const rest = rules.filter((r) => r.sel.includes('.c-sys') || r.sel.includes('.c-foot textarea'));
  chk(
    '★ 系统提示 + 输入框也开了（.c-sys / .c-note / .c-foot textarea）',
    rest.some((r) => /(^|[^-])user-select\s*:\s*text/.test(r.body)),
    rest.map((r) => r.sel).join(' | ')
  );

  // 顶部标题栏那条拖动区**不能**被开成可选 —— 拖窗口时会拖出一片选中残影
  const bar = rules.filter((r) => r.sel.split(',').map((s) => s.trim()).includes('.bar'));
  chk('没顺手把 .bar（拖动区）也开成可选', !bar.some((r) => /(^|[^-])user-select\s*:\s*text/.test(r.body)));
}

/* ============================================================
   #5 托盘单击
   ============================================================ */
console.log('');
console.log('── #5 托盘单击不再隐藏/显示桌宠 ──');
{
  const registered = [];
  let menuTemplate = null;
  const origLoad = Module._load;

  // 纯 node 里 require('electron') 只会拿到 exe 路径字符串，所以整颗换掉
  Module._load = function (req) {
    if (req === 'electron') {
      return {
        Tray: class {
          constructor() {}
          setToolTip() {}
          setContextMenu() {}
          on(ev) { registered.push(ev); }
          popUpContextMenu() {}
          destroy() {}
        },
        Menu: { buildFromTemplate: (t) => { menuTemplate = t; return t; } },
        nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({}) },
      };
    }
    return origLoad.apply(this, arguments);
  };

  let tray = null;
  try {
    tray = require(P('src', 'main', 'tray.cjs'));
  } finally {
    Module._load = origLoad;
  }

  let toggled = 0;
  const cfg = { all: () => ({ petVisible: true, sound: true, theme: 'light', moveEnabled: true }) };
  const api = {
    toggleShow() { toggled++; },
    set() {}, openSettings() {}, openChat() {}, quit() {},
  };

  tray.create(cfg, api);

  chk('托盘建起来了', !!tray && registered.length >= 0);
  chk(
    '★ 左键没注册任何监听（2026-10-17 他要求去掉「单击隐藏/显示」）',
    !registered.includes('click') && !registered.includes('double-click'),
    '注册过的事件：' + JSON.stringify(registered)
  );
  chk('右键菜单还在（setContextMenu 被调过）', !!menuTemplate, menuTemplate ? '' : '菜单没建');
  chk(
    '菜单第一项仍然是「显示/隐藏八千代」',
    !!menuTemplate && /隐藏八千代|显示八千代/.test(String(menuTemplate[0] && menuTemplate[0].label))
  );
  chk(
    '菜单里还留着 音效 / 夜间模式 / 桌宠移动 / 聊天 / 设置 / 退出',
    !!menuTemplate && ['音效', '夜间模式', '桌宠移动', '聊天…', '设置…', '退出']
      .every((t) => menuTemplate.some((m) => m.label === t))
  );
  chk('创建过程没有偷偷顺手 toggle 一次（他点一下她不会突然消失）', toggled === 0, String(toggled));
}

/* ============================================================
   #6 眼动跟随
   ============================================================ */
console.log('');
console.log('── #6 眼动跟随改为「互动后 N 秒内」 ──');
{
  const cfgMod = require(P('src', 'core', 'config.cjs'));
  chk(
    'config 默认值里有 gazeFollowSec = 15',
    cfgMod.DEFAULTS.gazeFollowSec === 15,
    String(cfgMod.DEFAULTS.gazeFollowSec)
  );
  chk(
    '它是**数字**（不是字符串，不然 `sec * 1000` 会算出 NaN）',
    typeof cfgMod.DEFAULTS.gazeFollowSec === 'number' && Number.isFinite(cfgMod.DEFAULTS.gazeFollowSec)
  );

  const app = stripComments(read('src/renderer/app.js'));

  chk('有 gazeActive() 这个门', /function\s+gazeActive\s*\(/.test(app));
  chk('有 markInteract() 记时刻', /function\s+markInteract\s*\(/.test(app));
  chk(
    '★ mousemove 喂给 rig 的 `on` 是 gazeActive()，不是恒 true',
    /rig\.mouse\s*=\s*\{[^}]*on\s*:\s*gazeActive\(\)/.test(app),
    (app.match(/rig\.mouse\s*=\s*\{[^}]*\}/) || ['(没找到)'])[0]
  );
  chk('★ 不再有 `on: true` 那种恒真写法', !/rig\.mouse\s*=\s*\{[^}]*on\s*:\s*true/.test(app));

  const markCalls = (app.match(/markInteract\(\)/g) || []).length;
  chk('★ 互动点都记了时刻（mousedown + contextmenu，至少 2 处）', markCalls >= 2, 'markInteract() 出现 ' + markCalls + ' 次（含定义 1 次）');
  chk(
    'mousedown（按她/拖她）那条路上有 markInteract',
    /addEventListener\('mousedown'[\s\S]{0,200}?markInteract\(\)/.test(app)
  );
  chk(
    'contextmenu（右键她）那条路上也有',
    /addEventListener\('contextmenu'[\s\S]{0,300}?markInteract\(\)/.test(app)
  );
  chk('gazeFollowSec <= 0 时干脆不跟（能当开关关掉）', /if\s*\(!\s*\(sec\s*>\s*0\)\s*\)\s*return\s+false/.test(app));
}

/* ============================================================
   #7 拖动放下的台词
   ============================================================ */
console.log('');
console.log('── #7 删掉拖动放下的台词 ──');
{
  const app = stripComments(read('src/renderer/app.js'));
  chk('★ 剥掉注释后，全文没有「嘿咻」了', !app.includes('嘿咻'));

  // 删的是那句话，不是那段逻辑 —— 位置还得照写
  chk(
    '松手写盘那段还在（别把功能一起删了）',
    /await window\.yachiyo\.cfg\.patch\(\{\s*petX:\s*pos\.x,\s*petY:\s*pos\.y\s*\}\)/.test(app)
  );
  chk('单击那几句台词还在（只删拖动那句）', /speak\(pick\(\[/.test(app));
}

console.log('');
console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
