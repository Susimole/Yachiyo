#!/usr/bin/env node
/**
 * selfcheck-looktool —— 「看屏幕」这个工具（第 40 轮 · #4 方案乙）
 *
 * 验**能静态验的部分**：文案、超时、工具定义、只有聊天链挂工具、记录形状，
 * 以及 2026-10-18 新加的「识图独立地址 + 基址补 /v1 + 不发 temperature + look.log」。
 *
 * ⚠️⚠️ **真实的三级降级这里还是验不了** —— 它要真发请求（花钱）。
 *    真正该验的是**他说一句「看看我屏幕」**（S1），以及用隔离配置造的 S2/S3
 *    （见 `D:\AI_work\_dsh020\verify\look-tiers.cjs`）。
 *    这一套只钉「形状和规则」，证明不了「她真看见了」。
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`），不碰他真实数据 —— 也不花一分钱
 *    （没填 key 时 `describe()` 在截屏之前就返回了）。
 *
 * 跑法：node scripts/selfcheck-looktool.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-look');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

let pass = 0;
let fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const lt = require('../../src/core/looktool.cjs');

console.log('selfcheck-looktool —— 看屏幕工具');
console.log('');

/* ---------- ① 固定文案 ---------- */
console.log('── ① 固定文案（他给的原话，一个字都不能改）──');
chk('BLIND 就是他给的那句',
  lt.BLIND === '什么都没看见...（当前对话模型无视觉模块/识图模型不可用）',
  lt.BLIND);
chk('文案里带"识图模型不可用"（他要求的三档理由之一）', lt.BLIND.includes('识图模型不可用'));

/* ---------- ② 超时 ---------- */
console.log('');
console.log('── ② 超时（他的降级链里有"超时"这一档，所以必须有明确的数）──');
chk('超时有明确值', typeof lt.TIMEOUT_MS === 'number' && lt.TIMEOUT_MS > 0, String(lt.TIMEOUT_MS));
chk('不超过 25 秒（识屏是顺手看一眼，不该跟正经对话耗一样久）', lt.TIMEOUT_MS <= 25000, String(lt.TIMEOUT_MS));

/* ---------- ③ 工具定义 ---------- */
console.log('');
console.log('── ③ 工具定义（模型靠 description 决定要不要看）──');
chk('名字是 look_screen', lt.TOOL && lt.TOOL.function && lt.TOOL.function.name === 'look_screen',
  lt.TOOL && lt.TOOL.function && lt.TOOL.function.name);
chk('type 是 function（OpenAI 格式）', lt.TOOL.type === 'function', lt.TOOL.type);
chk('parameters 是合法空对象（不吃参数）',
  lt.TOOL.function.parameters && lt.TOOL.function.parameters.type === 'object',
  JSON.stringify(lt.TOOL.function.parameters));
const desc = String(lt.TOOL.function.description || '');
chk('★ 描述里明说「只在他明确要求你看屏幕时使用」',
  /只在他明确要求/.test(desc), desc.slice(0, 60));
chk('★ 描述里明说「他只是在提到屏幕时不要调用」（防关键词触发）',
  /不要.*调用|不要调用/.test(desc), desc.slice(-60));

/* ---------- ④ 只挂聊天链 ---------- */
console.log('');
console.log('── ④ 只有聊天链才挂工具 ──');
const brainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'brain.cjs'), 'utf8');
chk('★ brain.cjs 里 tools 是按 chain 分流的（不是无条件挂）',
  /tools:\s*\(o\.chain \|\| 'chat'\) === 'chat'\s*\?\s*\[looktool\.TOOL\]\s*:\s*undefined/.test(brainSrc),
  '没匹配到那行');
chk('★ 第二次请求**不带** tools（避免它看完又要看）',
  (brainSrc.match(/tools:/g) || []).length === 1,
  'tools: 出现了 ' + (brainSrc.match(/tools:/g) || []).length + ' 次');

/* ---------- ⑤ 描述进记录 ---------- */
console.log('');
console.log('── ⑤ 描述进聊天记录 ──');
chk('★ 入库时带上 look（他要求"看完的描述要进记录"）',
  /memory\.push\('assistant',\s*out\.text,\s*lookMeta\s*\?/.test(brainSrc), '没匹配到 lookMeta');
chk('★ 记录里带 via（分得清"看见"还是"说了固定文案"）',
  /lookMeta\s*=\s*\{\s*desc:[^}]*via:/.test(brainSrc), '没匹配到 via');

/* ---------- ⑥ 识图独立配置（2026-10-18 加的） ---------- */
console.log('');
console.log('── ⑥ 识图能单独配地址 / 密钥 / 模型 ──');
chk('normBase 给没写路径的地址补 /v1（他给的 moonshot 地址少了这段）',
  lt.normBase('https://api.moonshot.cn') === 'https://api.moonshot.cn/v1',
  lt.normBase('https://api.moonshot.cn'));
chk('已经写了 /v1 的不重复补',
  lt.normBase('https://api.moonshot.cn/v1') === 'https://api.moonshot.cn/v1',
  lt.normBase('https://api.moonshot.cn/v1'));
chk('带别的路径一律不动（中转站可能不是 /v1）',
  lt.normBase('https://x.com/openai/v1') === 'https://x.com/openai/v1',
  lt.normBase('https://x.com/openai/v1'));

const cfgMod = require('../../src/core/config.cjs');
cfgMod.set('apiBase', 'https://api.deepseek.com');
cfgMod.set('apiKey', 'MAINKEY');
cfgMod.set('model', 'deepseek-flash');
cfgMod.set('screenBase', '');
cfgMod.set('screenKey', '');
cfgMod.set('screenModel', '');
const c1 = cfgMod.all();
const conn1 = lt.screenConn(c1);
chk('三个都留空 ⇒ 回落到主对话那套（老行为不变）',
  conn1.base === 'https://api.deepseek.com' && conn1.key === 'MAINKEY' && conn1.model === '',
  JSON.stringify({ base: conn1.base, key: conn1.key ? '(有)' : '(空)', model: conn1.model }));

cfgMod.set('screenBase', 'https://api.moonshot.cn');
cfgMod.set('screenKey', 'SCREENKEY');
cfgMod.set('screenModel', 'kimi-k2.6');
const conn2 = lt.screenConn(cfgMod.all());
chk('★ 填了就整套用识图那套（地址 / 密钥 / 模型各走各的）',
  conn2.base === 'https://api.moonshot.cn/v1' && conn2.key === 'SCREENKEY' && conn2.model === 'kimi-k2.6',
  JSON.stringify({ base: conn2.base, key: conn2.key, model: conn2.model }));
chk('识图日志写在数据目录里（不往仓库扔垃圾）',
  lt.LOG.endsWith(path.join('data', 'look.log')) && path.isAbsolute(lt.LOG), lt.LOG);

/* 回归：不改 temperature（kimi-k2.6 只认 1，传 0.3 会 400） */
const ltSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'looktool.cjs'), 'utf8');
chk('★ 看图请求**不发 temperature**（kimi-k2.6 只认 1，传 0.3 直接 400）',
  !/temperature\s*:/.test(ltSrc), '还留着 temperature');

/* ---------- ⑦ 真跑一次「没填 key」这一档（不截屏、不发请求、不花钱） ---------- */
(async () => {
  console.log('');
  console.log('── ⑦ 盲档真跑一次（隔离目录，没填 key ⇒ 截屏之前就返回）──');
  cfgMod.set('apiKey', '');
  cfgMod.set('screenKey', '');
  cfgMod.set('screenBase', '');
  const t0 = Date.now();
  const r = await lt.describe({ fromChat: true });
  chk('没钥匙时直接判盲，不截屏', r.via === 'blind' && /API Key/.test(r.why || ''), r.why);
  chk('返回值里带 ms（能算耗时了）', typeof r.ms === 'number', String(r.ms));
  chk('没调用任何 API（几乎瞬间返回）', Date.now() - t0 < 2000, (Date.now() - t0) + 'ms');

  const logTxt = fs.existsSync(lt.LOG) ? fs.readFileSync(lt.LOG, 'utf8') : '';
  chk('★ look.log 里真落了一行（这就是"哪一档给的"的凭据）',
    /via=blind/.test(logTxt), logTxt.trim().split('\n').slice(-1)[0] || '(空)');
  chk('日志里不出现密钥', logTxt.length > 0 && !/MAINKEY|SCREENKEY/.test(logTxt), '日志里看到了 key');

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
