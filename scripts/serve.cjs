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
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 只允许读 ROOT 里面的东西
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) {
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
