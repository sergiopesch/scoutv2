import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.VEYRA_PORT || 4173);
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
const isPublicPath = (value) =>
  value === 'index.html' ||
  value === 'styles.css' ||
  value === 'script.js' ||
  value.startsWith(`assets${process.platform === 'win32' ? '\\' : '/'}`);

createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8'
    });
    response.end('Method not allowed');
    return;
  }
  let pathname;
  let requestPath;
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requestPath = pathname === '/'
      ? 'index.html'
      : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  const candidate = normalize(join(root, requestPath));
  const pathFromRoot = relative(root, candidate);
  if (
    !isPublicPath(pathFromRoot) ||
    pathFromRoot.startsWith('..') ||
    pathFromRoot === '' ||
    !existsSync(candidate) ||
    statSync(candidate).isDirectory()
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const realCandidate = realpathSync(candidate);
  const realPathFromRoot = relative(root, realCandidate);
  if (
    !isPublicPath(realPathFromRoot) ||
    realPathFromRoot.startsWith('..') ||
    realPathFromRoot === '' ||
    realPathFromRoot.startsWith(
      `node_modules${process.platform === 'win32' ? '\\' : '/'}`
    )
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': mime[extname(realCandidate)] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(realCandidate).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`Veyra House is available at http://127.0.0.1:${port}`);
});
