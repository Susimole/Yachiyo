/**
 * 主进程 · AI 接入（2026-10-18 从 index.cjs 拆出来的第二块）
 *
 * 两条 IPC，**互相独立、别合并**：
 *   `ai:ping`   测试连接 —— 拿真 key 真发一句话，花钱、慢（思考模式十几秒）
 *   `ai:models` 检测模型 —— `GET /models`，免费、快，只验「地址通不通 + 有哪些型号」
 *
 * ⚠️ 这两件事的前提不一样：**检测模型不该要求先填 Key**
 *   （本地 vLLM / Ollama 根本不要 Key）。所以 models 那条是"先不带钥匙问一次，
 *   撞 401/403 才带钥匙重试"—— 细节见下面那段注释。
 */

'use strict';

const provider = require('../core/provider.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} cfg core/config.cjs
 */
function register(ipcMain, cfg) {

  /** 设置面板的「测试连接」—— 拿真 key 问一句最短的，验通了才算数 */
  ipcMain.handle('ai:ping', async () => {
    const c = cfg.all();
    if (!c.apiKey) return { ok: false, error: '还没填 API Key —— 「测试连接」要拿它真发一句话', needsKey: true };
    try {
      /*
       * ⚠️⚠️ 这里原来写的是 `model: c.thinking ? 'deepseek-reasoner' : c.model` ——
       *    **写死的模型名**，把他填的那个盖掉了。
       *    他 2026-10-12 报的就是这个：「我用其他的地址检测到模型但不可用，
       *    404 报错 model 'deepseek-reasoner' not found」——
       *    他明明在面板里选了别的模型，一点「测试连接」还是去打 deepseek-reasoner。
       *    测试连接要测的是**他配的那一套**，不是我们觉得好的那一套。
       */
      const r = await provider.ping({
        base: c.apiBase, key: c.apiKey,
        model: c.model,
        temperature: c.temperature ?? 0.1,
        thinking: c.thinking,
        reasoningEffort: c.thinkingDepth,
        thinkingStyle: c.thinkingStyle,
      });
      return { ok: true, text: r.text, ms: r.ms };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 检测模型 —— 问他填的那个接口地址「你有哪些模型」。
   *
   * ⚠️ 跟 ai:ping 是**两件事**，别合并：
   *    · ping（测试连接）= 真发一句话，验「能不能生成」—— 花钱、慢（思考模式十几秒）
   *    · models（检测模型）= GET /models，验「地址通不通 + 有哪些模型名」—— 免费、快
   *    这个按钮要的是后者：**看地址关联的模型，以及可用性**。
   *
   * ★ 2026-10-12 他报的：「应当可以先检测接口地址是否有对应模型，
   *   **而不是让用户填写 API 后才能检测**（填入 API 后是测试连接的事了）」。
   *   对 —— 这两步的前提本来就不一样。所以这里改成：
   *     ① 先**不带 Key** 问一次（本地 vLLM / Ollama 这类根本不要 Key）
   *     ② 撞 401/403 才**带上 Key** 重试
   *     ③ 还是不行 → 说人话：地址是通的，但这家要鉴权才能列模型
   *   ⚠️ 做不到「永远不填 Key 也能检测」—— 官方端点（实测 DeepSeek）不带 Key 就是 401。
   */
  ipcMain.handle('ai:models', async (_e, o) => {
    /*
     * ★ 2026-10-18 加的**可选参数**（不传 = 老行为，主对话那套）：
     *     `{ which: 'screen' }` —— 问「识图」那一套（screenBase / screenKey / screenModel）。
     *     `{ base, key }`     —— 显式指定（留给以后，页面上别传 key：页面收到的是打码值）。
     *
     *   ⚠️ 为什么密钥必须由**主进程**自己从磁盘取：
     *      页面拿到的 `apiKey` / `screenKey` 是 `••••••••`（`maskForPage`），
     *      它传回来的"钥匙"根本不是钥匙。
     */
    const c = cfg.all();
    const arg = (o && typeof o === 'object') ? o : {};
    const which = arg.which === 'screen';
    const base = String(arg.base || (which ? (c.screenBase || c.apiBase) : c.apiBase) || '').trim();
    const key = String(arg.key || (which ? (c.screenKey || c.apiKey) : c.apiKey) || '').trim();
    const cur = String(arg.current || (which ? (c.screenModel || c.model) : c.model) || '');
    if (!base) return { ok: false, error: '还没填接口地址', needsBase: true };

    const bail = (err) => ({
      ok: false,
      error: err.message,
      noList: !!err.noList,
      needsKey: !!err.needsKey,
      status: err.status,
      current: cur,
    });

    /*
     * ⚠️ 这里用返回值上报，**不能 throw** —— IPC handle 里抛出去会变成
     *    rejected promise，渲染层那边拿到的是个异常，`r.ok` 根本读不到。
     */
    try {
      try {
        const r = await provider.listModels({ base, key: '' });
        return { ok: true, url: r.url, ids: r.ids, current: cur, keyed: false };
      } catch (err) {
        const needAuth = err.status === 401 || err.status === 403;

        // ① 这家要鉴权，而且他还没填 Key → 把「地址是通的、只差钥匙」说清楚
        if (needAuth && !key) {
          return {
            ok: false, current: cur, needsKey: true, status: err.status,
            error: '地址是通的，但这家要鉴权才肯给模型清单 —— 填上 API Key 再点一次',
          };
        }

        // ② 要鉴权、也填了 Key → 拿 Key 重试一次
        if (needAuth) {
          try {
            const r = await provider.listModels({ base, key });
            return { ok: true, url: r.url, ids: r.ids, current: cur, keyed: true };
          } catch (err2) {
            if (!(err2.status === 401 || err2.status === 403)) return bail(err2);
            return bail(Object.assign(new Error('地址通了，但 Key 不对 —— 这家不认这把钥匙'), {
              status: err2.status, needsKey: true,
            }));
          }
        }

        // ③ 别的错（连不上 / 超时 / 404 没有 /models）原样上报
        return bail(err);
      }
    } catch (err) {
      return bail(err);      // 兜底：上面任何一处漏出来的异常都别变成 rejected promise
    }
  });

}

module.exports = { register };
