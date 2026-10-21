#!/usr/bin/env node
/**
 * selfcheck-providers —— AI 服务商预设的数据层（第 40 轮 · 批次 C）
 *
 * 他 2026-10-17 特意叮嘱「别把之前的代码弄坏」，所以这个自检里
 * **最要紧的一条**是 ①：迁移不能丢他正在用的那条 API Key。
 *
 * 跑在隔离家目录（`YACHIYO_HOME`）里，不碰他真实的 `%APPDATA%\Yachiyo`。
 *
 * ⚠️ 必须**先**设 YACHIYO_HOME、**先**写好那份「旧配置」，**再** require 产品代码 ——
 *    config.cjs 的目录常量是**模块加载那一刻**算出来的，顺序反了就测到真家目录上去了。
 *
 * 用法：node selfcheck-providers.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---------- 隔离 ---------- */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-prov-'));
process.env.YACHIYO_HOME = HOME;

let pass = 0;
let fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   → ' + detail : '')); }
};

/* ---------- 先铺一份「他现在的配置」：一份真在用的 DeepSeek key ---------- */
/*
 * ⚠️ 布局得照 config.cjs 的规矩来。这里直接问它要路径最稳 ——
 *    但 config 又得等 YACHIYO_HOME 设好才能 require，所以就按它的惯例拼。
 */
const cfgFile = path.join(HOME, 'config.json');
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });

const OLD = {
  apiBase: 'https://api.deepseek.com',
  apiKey: 'sk-OLDKEY-do-not-lose-me',
  model: 'deepseek-flash',
  petSize: 60,
};
fs.writeFileSync(cfgFile, JSON.stringify(OLD, null, 2), 'utf8');

/* ---------- 现在才允许加载产品代码 ---------- */
const providers = require('../../src/core/providers.cjs');
const cfg = require('../../src/core/config.cjs');

console.log('selfcheck-providers —— 服务商预设数据层');
console.log('家目录：' + HOME);
console.log('');

/* ---------- ① 迁移：他的 key 绝不能丢 ---------- */
console.log('── ① 从「单份配置」迁到「多预设」 ──');
const did = providers.migrate();
chk('第一次 migrate() 返回 true（说明真迁移了）', did === true);
chk('第二次 migrate() 返回 false（不会重复搬）', providers.migrate() === false);

const cur = providers.current();
chk('当前生效的预设是 deepseek（按地址猜出来的）', cur.id === 'deepseek', JSON.stringify(cur.id));
chk('★ 他那条 key 原样迁进了 deepseek 预设', cur.item && cur.item.key === OLD.apiKey,
  cur.item ? String(cur.item.key) : 'null');
chk('★ 模型名也迁过去了', cur.item && cur.item.model === OLD.model, cur.item && cur.item.model);
chk('★ 地址以 config 里那条为准（他真在用的那个）', cur.item && cur.item.base === OLD.apiBase, cur.item && cur.item.base);
chk('config 里的原值没被动过（读 config 的代码照旧能看到）',
  cfg.get('apiKey') === OLD.apiKey && cfg.get('apiBase') === OLD.apiBase);

const l0 = providers.list();
chk('内置 4 个预设都在：DeepSeek / Kimi / 智谱 GLM / 通义千问',
  ['deepseek', 'kimi', 'glm', 'qwen'].every((id) => l0.items.some((x) => x.id === id)),
  l0.items.map((x) => x.id).join(','));
chk('内置的都带 builtin 标记', l0.items.filter((x) => x.builtin).length === 4);

/* ---------- ② 每个预设各自一份 ---------- */
console.log('');
console.log('── ② 每个预设各自保存 ──');
providers.saveOne('kimi', { key: 'sk-KIMI', model: 'kimi-x' });
providers.activate('kimi');
chk('切到 Kimi 后，config 的 apiBase = Kimi 的地址', cfg.get('apiBase') === 'https://api.moonshot.cn/v1', cfg.get('apiBase'));
chk('★ 切到 Kimi 后，config 的 apiKey = Kimi 那份', cfg.get('apiKey') === 'sk-KIMI', cfg.get('apiKey'));
chk('★ DeepSeek 那份**没被冲掉**（切回来还在）',
  providers.list().items.find((x) => x.id === 'deepseek').key === OLD.apiKey);

providers.activate('deepseek');
chk('切回 DeepSeek，config 又变回他那条 key', cfg.get('apiKey') === OLD.apiKey, cfg.get('apiKey'));
chk('Kimi 那份也还在', providers.list().items.find((x) => x.id === 'kimi').key === 'sk-KIMI');

/* ---------- ③ 存当前生效的那个 = 立刻生效 ---------- */
console.log('');
console.log('── ③ 改当前预设，config 立刻跟着变 ──');
providers.activate('deepseek');
providers.saveOne('deepseek', { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
chk('存当前预设时顺手同步进 config（不然改完得再切一次才生效）',
  cfg.get('apiBase') === 'https://api.deepseek.com/v1' && cfg.get('model') === 'deepseek-chat',
  cfg.get('apiBase') + ' / ' + cfg.get('model'));

providers.saveOne('kimi', { base: 'https://api.moonshot.cn/v1' });
chk('存**非当前**的预设时，config 不受影响',
  cfg.get('apiBase') === 'https://api.deepseek.com/v1', cfg.get('apiBase'));

/* ---------- ④ 自定义预设 ---------- */
console.log('');
console.log('── ④ 自定义预设 ──');
const added = providers.addCustom('我的中转站');
chk('能加一个自定义预设', added.ok === true && !!added.id, JSON.stringify(added));
providers.saveOne(added.id, { base: 'http://127.0.0.1:9999/v1' });
chk('它自己那份能存', providers.list().items.find((x) => x.id === added.id).base === 'http://127.0.0.1:9999/v1');
chk('内置的不许删（删了下次也会补回来，白折腾）',
  providers.remove('deepseek').ok === false);
chk('自定义的能删', providers.remove(added.id).ok === true);
chk('删完就真的没了', !providers.list().items.some((x) => x.id === added.id));

/* ---------- ⑤ 猜平台 ---------- */
console.log('');
console.log('── ⑤ 按地址猜平台 ──');
chk('api.moonshot.cn → kimi', providers.guessId('https://api.moonshot.cn/v1') === 'kimi');
chk('open.bigmodel.cn → glm', providers.guessId('https://open.bigmodel.cn/api/paas/v4') === 'glm');
chk('dashscope.aliyuncs.com → qwen', providers.guessId('https://dashscope.aliyuncs.com/compatible-mode/v1') === 'qwen');
chk('认不出来的给 null（调用方会兜底，不抛）', providers.guessId('http://127.0.0.1:8087/v1') === null);

/* ---------- ⑥ 文件坏了也不能炸 ---------- */
console.log('');
console.log('── ⑥ 坏文件兜底 ──');
fs.writeFileSync(providers.FILE, '{ 这不是 json', 'utf8');
let threw = null;
let list = null;
try { list = providers.list(); } catch (e) { threw = e; }
chk('文件写坏了：不抛异常', threw === null, threw && threw.message);
chk('文件写坏了：内置 4 个照样回得来', list && list.items.filter((x) => x.builtin).length === 4,
  list && list.items.map((x) => x.id).join(','));

/* ---------- ⑦ 保险：config 空了要能补回来（2026-10-17 实测撞出来的坑）---------- */console.log('');
console.log('── ⑦ config 被清空时的补救 ──');
providers.activate('deepseek');
cfg.patch({ apiBase: 'https://api.deepseek.com/v1', apiKey: OLD.apiKey, model: OLD.model });
chk('config 有值的时候，ensureConfig() 什么都不做（返回 false）', providers.ensureConfig() === false);

/*
 * 复现那个坑：切到 Kimi（它 Key 是空的）⇒ 那份空值被写进 config ⇒
 * 关掉再启动就成了「我的 Key 丢了」。真身在 providers.json，config 只是副本。
 */
providers.activate('kimi');
chk('切到 Kimi 之后 config 的 Key 真的空了（这就是那个坑）', cfg.get('apiKey') === '', JSON.stringify(cfg.get('apiKey')));

providers.activate('deepseek');
/*
 * ⚠️ 先把预设**显式写满**再测 —— 这一段要验的是 `ensureConfig` 这一个函数，
 *    别让它受前面几步留下的状态影响（第一版就吃了这个亏：
 *    预设里 key 是空的，于是"补回来"当然补不出东西，红了还以为是产品坏了）。
 */
providers.saveOne('deepseek', { base: 'https://api.deepseek.com/v1', key: OLD.apiKey, model: OLD.model });
cfg.patch({ apiBase: '', apiKey: '', model: '' });   // 人为把它清成"丢了"的样子
chk('人为清空后，config 确实是空的', !cfg.get('apiBase') && !cfg.get('apiKey'));
const fixed = providers.ensureConfig();
chk('★ ensureConfig() 报告「补了」', fixed === true);
chk('★ apiKey 从预设里补回来了', cfg.get('apiKey') === OLD.apiKey, cfg.get('apiKey'));
chk('★ apiBase 和 model 也补回来了',
  cfg.get('apiBase') === 'https://api.deepseek.com/v1' && cfg.get('model') === OLD.model,
  cfg.get('apiBase') + ' / ' + cfg.get('model'));
chk('补过一次之后再调就没事干了（不会反复写盘）', providers.ensureConfig() === false);

/* ---------- ⑧ 删掉「正在用」的那个预设：config 必须跟着切走 ---------- */
/*
 * ★ 2026-10-21 加，对应外部审查 YCH-001（确定复现）。
 *
 *   改前：`remove()` 只把 `d.active` 改成 deepseek，**没把新 active 写回 config**。
 *   ⇒ 页面显示"已切到 DeepSeek"，而 config 里还是被删那套的 base/key/model，
 *     请求照样打向已经删掉的地址，而且不报错。
 */
console.log('');
console.log('── ⑧ 删掉正在用的预设 ──');
const c2 = providers.addCustom('要删的那个');
providers.saveOne(c2.id, { base: 'http://127.0.0.1:9998/v1', key: 'sk-DELETED-should-not-survive', model: 'gone-model' });
providers.activate(c2.id);
chk('切过去之后 config 里是它那套',
  cfg.get('apiBase') === 'http://127.0.0.1:9998/v1' && cfg.get('model') === 'gone-model',
  cfg.get('apiBase') + ' / ' + cfg.get('model'));

const rm = providers.remove(c2.id);
chk('删成功，并且报告「动到了当前在用的那套」', rm.ok === true && rm.switched === true, JSON.stringify(rm));
chk('★ config 的地址切回了新 active（deepseek）',
  cfg.get('apiBase') === 'https://api.deepseek.com/v1', String(cfg.get('apiBase')));
chk('★ config 的模型也跟着切了（没留着被删那个）',
  cfg.get('model') !== 'gone-model', String(cfg.get('model')));
chk('★ 被删那套的 Key 没留在 config 里',
  cfg.get('apiKey') !== 'sk-DELETED-should-not-survive', String(cfg.get('apiKey')));

/* 删**不是**当前在用的那个，不该动 config */
const c3 = providers.addCustom('闲着的那个');
providers.activate('deepseek');
const keepBase = cfg.get('apiBase');
const rm2 = providers.remove(c3.id);
chk('删一个没在用的预设：报告 switched=false', rm2.ok === true && rm2.switched === false, JSON.stringify(rm2));
chk('删一个没在用的预设：config 一个字节都不动', cfg.get('apiBase') === keepBase, cfg.get('apiBase'));

/* ---------- ⑨ 清干净 ---------- */
fs.rmSync(HOME, { recursive: true, force: true });

console.log('');
console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
