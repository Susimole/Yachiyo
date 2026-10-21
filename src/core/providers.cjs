/**
 * AI 服务商预设 —— 每个平台**各自一套**接入配置（接口地址 / API Key / 模型）。
 *
 * 他 2026-10-17 定的口径：
 *   · 预设只放**国内知名、可接入 API** 的平台（DeepSeek / Kimi / 智谱 GLM / 通义千问…）
 *     —— **不放本地模型**（他自己的 llama.cpp 不进预设）
 *   · **单独开文件**（`data/providers.json`），不塞进 `config.json`：
 *     每个平台的 API 口径不一样，混在一个大 config 里会越来越乱
 *   · **每个预设各自保存自己的 API**，切换 = 换整套
 *
 * ★★★ 跟老代码的关系（这条是**风险控制的关键**，别改）：
 *
 *   本文件**不接管**任何读取方。`config.json` 里的 `apiBase` / `apiKey` / `model`
 *   继续是「**当前生效的那一套**」—— `provider.cjs` / `peeker.cjs` / `profile.cjs` /
 *   `websearch.cjs` / `review.cjs` 全都照旧读 config，**一行都不用改**。
 *
 *   `providers.json` 只干一件事：**记住每个预设各自那份**。
 *   切预设 = 把那份**写回 config**（见 `activate()`），于是全工程自动跟着变。
 *
 *   ⇒ 这样加功能**不会碰到任何既有链路** —— 他 2026-10-17 特意叮嘱「别把之前的代码弄坏」。
 */
'use strict';

const path = require('node:path');
const store = require('./store.cjs');
const cfgMod = require('./config.cjs');

const FILE = path.join(cfgMod.DATA, 'providers.json');

/**
 * 内置预设。
 *
 * ⚠️⚠️ `base` 是**默认值，用户可以改** —— 这些平台的口径一年变好几回
 *    （文档改版、域名换、加/去 `/v1`），写死在代码里就是给未来的自己挖坑。
 * ⚠️ `model` **故意留空**：模型名变得更快，靠设置面板那颗「检测模型」按钮
 *    现问 `GET /models` 比我们猜准得多（那颗按钮和它的链路本来就有）。
 */
const BUILTIN = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
  { id: 'kimi',     name: 'Kimi',     base: 'https://api.moonshot.cn/v1' },
  { id: 'glm',      name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen',     name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
];

const BUILTIN_IDS = BUILTIN.map((b) => b.id);

/** 空文件长这样。⚠️ `migrated` 必须在 —— 见 `migrate()`。 */
const EMPTY = { active: '', items: {}, migrated: false };

function blank() {
  return { active: '', items: {}, migrated: false };
}

/** 读盘 + 补齐内置项（缺哪个补哪个，用户改过的值不动） */
function load() {
  const raw = store.readJson(FILE, null);
  const d = (raw && typeof raw === 'object') ? raw : blank();
  if (!d.items || typeof d.items !== 'object') d.items = {};

  for (const b of BUILTIN) {
    const cur = d.items[b.id];
    if (!cur || typeof cur !== 'object') {
      d.items[b.id] = { name: b.name, base: b.base, key: '', model: '' };
    } else {
      // 名字和地址：只在**空的**时候补默认 —— 他改过就不动
      if (!cur.name) cur.name = b.name;
      if (!cur.base) cur.base = b.base;
      if (typeof cur.key !== 'string') cur.key = '';
      if (typeof cur.model !== 'string') cur.model = '';
    }
  }
  if (typeof d.migrated !== 'boolean') d.migrated = false;
  return d;
}

function save(d) {
  store.writeJson(FILE, d);
  return d;
}

/**
 * 猜这一套配置属于哪个内置预设 —— **迁移时用**。
 * 认不出来就返回 null（调用方会把它落到 deepseek 那格，反正地址也跟着一起存，不丢）。
 */
function guessId(base) {
  const b = String(base || '').toLowerCase();
  if (!b) return null;
  if (b.includes('deepseek')) return 'deepseek';
  if (b.includes('moonshot') || b.includes('kimi')) return 'kimi';
  if (b.includes('bigmodel') || b.includes('zhipu') || b.includes('glm')) return 'glm';
  if (b.includes('dashscope') || b.includes('aliyuncs') || b.includes('qwen')) return 'qwen';
  return null;
}

/**
 * ★ 首次运行：把 `config.json` 里**正在用的那一套**搬进预设，别让他重填。
 *
 *   他是 2026-10-17 从「一份配置」切到「多预设」的，config 里躺着一条真在用的
 *   DeepSeek key。迁移要是没做，他打开设置面板会看到预设全是空的，
 *   以为 key 丢了 —— 而那是**不可逆的观感损失**（就算文件里有，他也不敢再点）。
 *
 * @returns {boolean} 这次有没有真的迁移
 */
function migrate() {
  const d = load();
  if (d.migrated) return false;

  const base = String(cfgMod.get('apiBase') || '').trim();
  const key = String(cfgMod.get('apiKey') || '').trim();
  const model = String(cfgMod.get('model') || '').trim();

  if (base || key) {
    const id = guessId(base) || 'deepseek';
    // ⚠️ 只覆盖**空**的格子：万一他手动先配过，别把新的盖掉
    const slot = d.items[id] || (d.items[id] = { name: id, base: '', key: '', model: '' });
    if (!slot.key && key) slot.key = key;
    if (!slot.model && model) slot.model = model;
    if (base) slot.base = base;              // 地址以 config 里那条为准（他真在用）
    d.active = id;
  } else {
    d.active = d.active || 'deepseek';
  }

  d.migrated = true;
  save(d);
  return true;
}

/** 给外面看的一览（⚠️ 带 key —— 设置面板要能显示/编辑它；这是本地应用，跟原来一致） */
function list() {
  const d = load();
  const items = Object.keys(d.items).map((id) => {
    const it = d.items[id];
    return {
      id,
      name: it.name || id,
      base: it.base || '',
      key: it.key || '',
      model: it.model || '',
      builtin: BUILTIN_IDS.includes(id),
    };
  });
  // 内置的排在前面（照 BUILTIN 的顺序），自定义的按 id 排后面
  items.sort((a, b) => {
    const ia = BUILTIN_IDS.indexOf(a.id);
    const ib = BUILTIN_IDS.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.id.localeCompare(b.id);
  });
  return { active: d.active || '', items };
}

/**
 * 存某个预设的一份配置。
 * ⚠️ 如果存的是**当前生效的那个**，顺手同步进 config —— 不然他改完地址得再切一次才生效。
 */
function saveOne(id, patch = {}) {
  const d = load();
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: '没给预设 id' };
  const cur = d.items[key] || (d.items[key] = { name: key, base: '', key: '', model: '' });
  if (typeof patch.name === 'string' && patch.name.trim()) cur.name = patch.name.trim();
  if (typeof patch.base === 'string') cur.base = patch.base.trim();
  if (typeof patch.key === 'string') cur.key = patch.key;
  if (typeof patch.model === 'string') cur.model = patch.model.trim();
  save(d);
  if (d.active === key) applyToConfig(cur);
  return { ok: true, item: { id: key, ...cur } };
}

/**
 * ★★ 保险：config 里那三项**空了**、而当前预设里还有值 ⇒ 补回去。
 *
 *   2026-10-17 实测撞出来的：他切到 Kimi（Kimi 的 Key 是空的、只有地址）
 *   ⇒ `activate` 把那份**空 Key** 写进了 config ⇒ 关掉桌宠再启动，
 *   她读到的就是那份空的 —— **看起来就是"我的 API Key 丢了"**。
 *
 *   为什么会丢到"全空"：切走的那一下，config 里原来是 DeepSeek 的值，
 *   但没有任何一步把它记回 **DeepSeek 那个预设**（预设里是有的，那是迁移时存的）；
 *   而 config 只是"当前生效的副本"，副本被后来那份空的盖掉了。
 *
 *   ⇒ 真身在 providers.json，config 是副本。**副本空着就拿真身补**。
 *      启动时调一次，他自己怎么切都不会把可用配置弄丢。
 *
 * @returns {boolean} 这次有没有补
 */
function ensureConfig() {
  const d = load();
  const id = d.active && d.items[d.active] ? d.active : (BUILTIN_IDS[0] || '');
  const it = id ? d.items[id] : null;
  if (!it) return false;
  const base = String(cfgMod.get('apiBase') || '').trim();
  const key = String(cfgMod.get('apiKey') || '').trim();
  const empty = !base && !key;
  const has = (it.base || it.key);
  if (empty && has) {
    applyToConfig(it);
    return true;
  }
  return false;
}

/** 加一个自定义预设（他说本地模型不进**内置**预设 —— 但自己加的口子得留着） */
function addCustom(name) {
  const d = load();
  const clean = String(name || '').trim() || '自定义';
  // id 用时间戳，稳、不会跟内置撞
  const id = 'custom-' + Date.now().toString(36);
  d.items[id] = { name: clean, base: '', key: '', model: '' };
  save(d);
  return { ok: true, id };
}

/** 删一个预设。⚠️ **内置的不许删**（删了下次 load 又会补回来，白折腾） */
function remove(id) {
  const d = load();
  if (BUILTIN_IDS.includes(id)) return { ok: false, error: '内置预设不能删，改掉里面的内容就行' };
  if (!d.items[id]) return { ok: false, error: '没有这个预设' };
  delete d.items[id];
  const wasActive = d.active === id;
  if (wasActive) d.active = BUILTIN_IDS[0] || '';
  save(d);
  /*
   * ★★ 2026-10-21 修（外部审查 YCH-001）：
   *    删掉的**正是当前在用的那套** ⇒ 必须把新 active 写回 config。
   *
   *    原来只改 `d.active` 就 return 了 —— config 里还留着**被删那套**的
   *    base / key / model。于是页面显示「已经切到 DeepSeek 了」（UI 拿的是
   *    providers.json 那份），而 `provider.cjs` 照旧读 config ⇒
   *    **请求还打向刚被删掉的那个地址**，而且不报错。这就是"假成功"。
   *
   *    ⚠️ 只在自己被删时才写回 —— 删别的预设不该动 config。
   *    ⚠️ `applyToConfig` 走 `cfgMod.patch`，全工程读 config 的模块自动跟上。
   */
  if (wasActive && d.items[d.active]) applyToConfig(d.items[d.active]);
  return { ok: true, active: d.active, switched: wasActive };
}

/** 把这套值写进 config —— ★ 全工程都读 config，所以这就是「切换生效」的全部动作 */
function applyToConfig(it) {
  cfgMod.patch({ apiBase: it.base || '', apiKey: it.key || '', model: it.model || '' });
}

/**
 * 切到某个预设 —— **把它的值写回 config**。
 * @returns {{ok:boolean, error?:string, item?:object}}
 */
function activate(id) {
  const d = load();
  const it = d.items[id];
  if (!it) return { ok: false, error: '没有这个预设' };
  d.active = id;
  save(d);
  applyToConfig(it);
  return { ok: true, item: { id, ...it } };
}

/** 当前生效的是哪个 + 它那份值（设置面板打开时用来对账） */
function current() {
  const d = load();
  const id = d.active && d.items[d.active] ? d.active : (BUILTIN_IDS[0] || '');
  return { id, item: id ? { id, ...d.items[id] } : null };
}

/** 清掉所有自定义预设（自检用；⚠️ 不动内置） */
function _reset() {
  save(blank());
  return load();
}

module.exports = {
  FILE, BUILTIN, BUILTIN_IDS,
  load, list, saveOne, addCustom, remove, activate, current, migrate, guessId, ensureConfig,
  _reset,
};
