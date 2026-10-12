/**
 * 自检 · 联网（A）
 *
 * 这条链最容易被**假成功**骗 —— 当年 `/responses` 返回 200、一次都没搜、
 * 模型拿旧知识编答案，他看着答得头头是道，被骗了整整一天。
 * 所以这里主力钉两件事：
 *   ① **`server_tool_use` 那个数**（0 = 没搜 = 答案不可信 → 必须判失败）
 *   ② **解析只取 text 块**（thinking / 搜索结果原文一个都不能混进来）
 *
 * ⚠️ 跑在隔离目录里。跑法：node scripts/selfcheck-4e.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..');
const HOME = path.join(ROOT, '_selfcheck-home-4e');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const web = require(path.join(ROOT, 'src/core/websearch.cjs'));
const prompt = require(path.join(ROOT, 'src/core/prompt.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/* ── 假 Anthropic 端点 ─────────────────────────────────── */
const PORT = 8795;
let lastReq = null;
let replyMode = 'ok';        // ok | nouses | empty | http500 | notjson
let replyText = '';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 记原样 */ }
    lastReq = { headers: req.headers, body: parsed };

    if (replyMode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    if (replyMode === 'notjson') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>不是 JSON</html>');
      return;
    }

    const content = [];
    if (replyMode !== 'nouses') {
      // ⚠️ 故意混进另外三种块 —— 解析只该取 text
      content.push({ type: 'thinking', thinking: '先想想他到底想问什么…' });
      content.push({ type: 'server_tool_use', id: 'tu_1', name: 'web_search' });
      content.push({ type: 'web_search_tool_result', tool_use_id: 'tu_1', content: [{ title: '原始结果', url: 'http://x' }] });
    }
    if (replyMode !== 'empty') {
      content.push({ type: 'text', text: replyText });
    } else {
      content.push({ type: 'server_tool_use', id: 'tu_2', name: 'web_search' });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content }));
  });
});

/* ═══════════════════════════════════════════════════════ */

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const reset = () => {
    web._reset();
    lastReq = null;
    replyMode = 'ok';
    replyText = '据查，2026 年世界杯冠军是巴西队。';
    cfg.patch({
      AiEnabled: true, apiKey: 'sk-test-web',
      apiBase: `http://127.0.0.1:${PORT}`,
      webEnabled: true, webApiUrl: '', webMaxUses: 3,
      webMaxOutputTokens: 1500, webTimeoutSeconds: 8, webMaxPerDay: 20,
    });
  };

  try {
    /* ── 判据 ── */
    console.log('\n【什么时候才查】');
    reset();
    const cases = [
      ['今天有什么新闻', true], ['最新那个游戏出了吗', true], ['搜一下三体电视剧', true],
      ['帮我查查明天的天气', true], ['2026年世界杯冠军是谁', true], ['这游戏多少钱', true],
      ['别查了', false], ['不用搜了', false], ['今天吃了火锅', false], ['我有点累', false],
      ['今天天气不错', false], ['你现在在干嘛', false], ['最近有点忙', false],
      ['别吵我，等会儿再查', false],
      // ★ 2026-10-13 他真问过的一句 —— 旧判据只给 1 分，够不到门槛所以没查
      ['今年国务院颁发文件法定节假日对应日期和假期时长是多少', true],
      ['这是为什么呢？因为我觉得挺有意思的', false],
      ['我今天很高兴', false],
    ];
    let bad = 0;
    for (const [q, want] of cases) {
      const got = web.shouldSearch(q);
      if (got !== want) { bad++; console.log(`     ✗ 「${q}」 期望 ${want} 实际 ${got}  分数=${JSON.stringify(web.score(q))}`); }
    }
    chk('★ 17 句判据全对（含"今天吃了火锅"这种弱词陷阱、和否定词）', bad === 0, `${cases.length - bad}/${cases.length}`);

    chk('★ 「今天」单弱词不够 2 分（不然每天闲聊全去联网）',
      web.score('今天吃了火锅').total === 1, String(web.score('今天吃了火锅').total));
    chk('  「今天的新闻」弱+强 = 3 分', web.score('今天有什么新闻').total >= 2, String(web.score('今天有什么新闻').total));

    /* ── 端点 ── */
    console.log('\n【端点地址】');
    reset();
    chk('  没配 webApiUrl → 按 apiBase 拼 /anthropic/v1/messages',
      web.url() === `http://127.0.0.1:${PORT}/anthropic/v1/messages`, web.url());
    cfg.set('webApiUrl', 'https://example.com/x');
    chk('  配了就用配的', web.url() === 'https://example.com/x', web.url());
    reset();

    /* ── 请求格式 ── */
    console.log('\n【请求格式（错了对面会静默忽略）】');
    reset();
    await web.search('2026年世界杯冠军是谁');
    const b = (lastReq || {}).body || {};
    chk('★ 带上了 tools 里的 `web_search_20250305`（写成别的会被静默忽略）',
      b.tools && b.tools[0] && b.tools[0].type === 'web_search_20250305',
      JSON.stringify(b.tools));
    chk('  max_uses 按配置传了', b.tools && b.tools[0].max_uses === 3, String(b.tools && b.tools[0].max_uses));
    chk('★ Anthropic 那套要 max_tokens（必填）', b.max_tokens === 1500, String(b.max_tokens));
    chk('  带上了 anthropic-version 头',
      (lastReq.headers || {})['anthropic-version'] === '2023-06-01',
      String((lastReq.headers || {})['anthropic-version']));
    chk('  带上了 x-api-key 头',
      String((lastReq.headers || {})['x-api-key'] || '').startsWith('sk-'),
      String((lastReq.headers || {})['x-api-key']).slice(0, 8));
    chk('  问题原样传过去了', b.messages && b.messages[0].content === '2026年世界杯冠军是谁',
      JSON.stringify(b.messages && b.messages[0] && b.messages[0].content));

    /* ── 解析 ── */
    console.log('\n【解析：只取 text 块，其它三种一律不要】');
    reset();
    const r1 = await web.search('2026年世界杯冠军是谁');
    chk('  查到答案了', r1.ok === true, r1.why || `${r1.answer.length} 字`);
    chk('★ 答案里**没有** thinking 的内心戏', !/先想想他到底想问什么/.test(r1.answer), r1.answer.slice(0, 40));
    chk('★ 答案里**没有**原始搜索结果', !/原始结果/.test(r1.answer), '');
    chk('  答案就是那个 text 块', r1.answer === '据查，2026 年世界杯冠军是巴西队。', r1.answer);

    console.log('\n【★★ server_tool_use 那个数 = 唯一的可验收指标】');
    /*
     * ⚠️ 口径 2026-10-13 改过：**优先用服务端给的
     *    `usage.server_tool_use.web_search_requests`**
     *    （打真接口时发现的 —— DeepSeek 会回这个字段，比数块准）。
     *    假服务**故意不给**那个字段 → 退回数 `server_tool_use` 块。
     *    这里假服务只有 1 个 tool_use 块（result 是它的回声，不另算一次）。
     */
    chk('★ 数出来了（假服务不给官方字段 → 退回数块 = 1）', r1.uses === 1, String(r1.uses));

    reset();
    replyMode = 'nouses';                     // 服务端没搜，但照样给一大段答案（当年就是这个骗局）
    replyText = '巴西队夺得了 2026 年世界杯冠军，这是他们的第六次夺冠。';
    const r2 = await web.search('2026年世界杯冠军是谁');
    chk('★★ **一次都没搜 → 判失败**（哪怕答案写得头头是道）',
      r2.ok === false && r2.uses === 0, `ok=${r2.ok} uses=${r2.uses} why=${r2.why}`);
    chk('  而且**没把它存下来**（不能被编的答案污染提示词）', web.last() === null, '');

    reset();
    replyMode = 'empty';                      // 搜了但没答出来
    const r3 = await web.search('2026年世界杯冠军是谁');
    /*
     * ⚠️ 要钉的是"搜了但没答案 → 算失败"，**不是那个数**。
     *    （empty 模式下我塞了两个 use 块，那是**测试数据**不是产品行为。）
     */
    chk('  搜了但没答案 → 也算失败', r3.ok === false && r3.uses > 0, `uses=${r3.uses} why=${r3.why}`);

    reset();
    replyMode = 'http500';
    const r4 = await web.search('查一下');
    chk('  端点回 500 → 失败但说人话', r4.ok === false && /500/.test(r4.why), r4.why);

    reset();
    replyMode = 'notjson';
    const r5 = await web.search('查一下');
    chk('  回来不是 JSON → 失败但不炸', r5.ok === false, r5.why);

    /* ── 进提示词 ── */
    console.log('\n【查到的怎么进提示词】');
    reset();
    chk('  没查过 → 那一块整个不出现', web.buildBlock() === '', '');
    chk('★ 没查过时系统提示词里也没有"刚上网查到的"',
      !/刚上网查到的/.test(prompt.buildSystem({ userText: '你好' })), '');

    reset();
    await web.search('2026年世界杯冠军是谁');
    const blk = web.buildBlock();
    chk('★ 查过之后出现了那一块', /刚上网查到的/.test(blk), '');
    chk('  带上了他问的原话', /他问的是：2026年世界杯冠军是谁/.test(blk), '');
    chk('  带上了答案', /巴西队/.test(blk), '');
    chk('★ 说了"用你自己的话讲、别整段照念"（不这么说她会照抄）',
      /用你自己的话讲/.test(blk) && /别整段照念/.test(blk), '');
    /*
     * ★ 2026-10-13 补：实测查回来的原文是**一整张 markdown 表格**（1161 字）——
     *   不说清楚她会照着念，而他问"放假几天"要的是一句话。
     */
    chk('★★ 明确说了"别贴表格"（查回来的是表格，不拦就会整张糊他脸上）',
      /别贴表格/.test(blk) && /竖线/.test(blk), '');
    chk('★ 说了"问多少答多少，别把七个节日全念一遍"',
      /别把七个节日全念一遍/.test(blk), '');
    chk('★ 真的进了系统提示词', /刚上网查到的/.test(prompt.buildSystem({ userText: '那冠军是谁' })), '');

    /* ── 保鲜期 ── */
    console.log('\n【保鲜期：过了就不带了】');
    reset();
    await web.search('2026年世界杯冠军是谁');
    chk('  刚查完：有', web.last() !== null, '');
    chk('★ 超过保鲜期（10 分钟）→ 当没有（不然十分钟后她还在念旧新闻）',
      (() => {
        const st = store.readJson(web.FILE, {});
        st.at = Date.now() - (web.FRESH_MS + 60000);
        store.writeJson(web.FILE, st);
        return web.last() === null && web.buildBlock() === '';
      })(), '');

    /* ── 开关 / 上限 ── */
    console.log('\n【开关与上限】');
    reset();
    cfg.set('webEnabled', false);
    const r6 = await web.search('查一下');
    chk('  联网关着 → 不查', r6.ok === false && /关着/.test(r6.why), r6.why);
    chk('  关着的时候提示词里也不带', web.buildBlock() === '', '');
    reset();

    /*
     * ⚠️ **必须先 reset 再改上限** —— 第一版是先改上限后 reset，
     *    而 reset() 里会把 webMaxPerDay 写回 20，那条断言就永远绿不了。
     *    ⚠️ reset() 也会把 replyMode 复位成 'ok'，顺手把上一个用例的 empty 清掉。
     */
    reset();
    cfg.set('webMaxPerDay', 2);
    await web.search('查一下啊');
    await web.search('再查一下');
    const r7 = await web.search('还查一下');
    chk('★ 超过每日上限 → 不查了', r7.ok === false && /今天已经查过/.test(r7.why), r7.why);
    chk('  计数是按天的', web.countToday() === 2, String(web.countToday()));
    cfg.set('webMaxPerDay', 20);

    reset();
    const s = store.readJson(web.FILE, {});
    s.day = '2020-01-01'; s.n = 99;         // 假装是过去某天查了 99 次
    store.writeJson(web.FILE, s);
    chk('★ 跨天之后计数归零（第一版这里写错了，永远不归零）',
      web.countToday() === 0, String(web.countToday()));

    /* ── 没配 Key ── */
    reset();
    cfg.set('apiKey', '');
    const r8 = await web.search('查一下');
    chk('  没填 Key → 不查', r8.ok === false && /API Key/.test(r8.why), r8.why);

    /* ── 隔离 ── */
    console.log('\n【隔离检查】');
    const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
    chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4e'), HOME);
    chk('  他真那份的联网状态没被动过',
      !fs.existsSync(path.join(REAL, 'data', 'state', 'web.json'))
      || fs.statSync(path.join(REAL, 'data', 'state', 'web.json')).mtimeMs < STARTED, '');

  } finally {
    server.close();
  }

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { try { server.close(); } catch { } console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
