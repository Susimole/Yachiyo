/**
 * 开发用静态服务器。
 *
 * 为什么需要它：浏览器 / Electron 直接打开本地 HTML 时，`fetch()` 读同目录的
 * rig.json 会被 CORS 拦掉（file:// 协议的限制）。起一个本地 http 就能绕开，
 * 而且改一行刷一下就见效，比每次重启 Electron 快得多。
 *
 *   npm run serve   →  http://127.0.0.1:7788/rig-test.html
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 7788);
const ROOT = path.join(__dirname, '..', 'src', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  /*
   * ⚠️ `decodeURIComponent` 是会**抛**的（2026-10-17 修的，清单 #49）。
   *    请求里只要有非法的百分号转义（比如 `/%`），它当场抛 URIError ——
   *    而这里原来没有 try/catch ⇒ **整个进程直接死**。
   *    实测改前：`curl --path-as-is .../%` → 服务器没了（HTTP 000），
   *    之后连正常页面也一起打不开。
   *    这是开发用的小服务器，但"随手访问一个怪 URL 就整个挂掉"太脆了。
   */
  let rel;
  try {
    rel = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('400 路径里的转义不合法');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  /*
   * 只允许读 ROOT 里面的东西。
   *
   * ⚠️ 判据要带上**路径分隔符**（2026-10-17 修的，清单 #49）：
   *    原来写的是 `full.startsWith(ROOT)` —— 于是 `…\src\renderer-x\…`
   *    这种**同级的兄弟目录**也会被当成"在 ROOT 里面"放行
   *    （`renderer` 恰好是 `renderer-x` 的前缀）。
   *    现在 `src/` 下没有别的同级目录，所以今天利用不了 —— 但这是真漏洞，
   *    哪天有人加个 `src/renderer-dev/` 就自动漏了。
   */
  const full = path.normalize(path.join(ROOT, rel));
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!full.startsWith(rootWithSep)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`静态服务器: http://127.0.0.1:${PORT}/rig-test.html`);
  console.log(`根目录    : ${ROOT}`);
});
