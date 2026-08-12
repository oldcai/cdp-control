import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PROTECTED_PORTS = new Set([9222, 9223]);

export interface FixtureServer {
  server: Server;
  url: string;
  port: number;
}

function fixtureHtml(token: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CDP Integration Fixture ${token}</title>
  <style>
    body { font: 16px sans-serif; margin: 24px; line-height: 1.5; }
    main { max-width: 800px; }
    section, article { border: 1px solid #bbb; margin: 16px 0; padding: 12px; }
    button, input { min-height: 36px; margin: 4px; }
  </style>
</head>
<body>
  <main id="fixture-root">
    <h1>CDP Integration Fixture</h1>

    <section id="view-region">
      <label for="fixture-input">Fixture value</label>
      <input id="fixture-input" value="before" placeholder="Fixture input">
      <button id="semantic-state" aria-pressed="true" aria-expanded="true" disabled>Semantic State</button>
    </section>

    <section id="action-region">
      <button id="trusted-click">Trusted Coordinate Click</button>
      <div id="click-output" aria-live="polite"></div>
    </section>

    <section id="dynamic-find-region">
      <p>Dynamic find target starts absent</p>
    </section>

    <section id="fold-region">
      <h2>Fold region heading</h2>
      <p>FOLD_SECRET_SHOULD_HIDE</p>
    </section>

    <section id="recovery-container">
      <h2>Recovery region</h2>
      <button id="recovery-target">Recovery Target</button>
      <p>Recovery anchor survives</p>
    </section>

    <article id="fixture-article">
      <h1>Integration Heading</h1>
      <p>Before <a href="https://example.test/docs">Example link</a> after <strong>bold</strong> and <em>italic</em>.</p>
      <ul><li>First item</li><li>Second item</li></ul>
      <blockquote>Quote from fixture</blockquote>
      <pre>const answer = 42;</pre>
    </article>
  </main>
  <script>
    document.querySelector('#trusted-click').addEventListener('click', (event) => {
      const line = document.createElement('p');
      line.id = 'trusted-click-result';
      line.textContent = 'Trusted click observed: isTrusted=' + event.isTrusted;
      document.querySelector('#click-output').append(line);
    });
    window.fixtureAddFindTarget = () => {
      const button = document.createElement('button');
      button.id = 'dynamic-find-target';
      button.textContent = 'Find Newly Added Reference';
      document.querySelector('#dynamic-find-region').append(button);
      return true;
    };
    window.fixtureReady = true;
  </script>
</body>
</html>`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

/**
 * 在 127.0.0.1:0 上取系统随机空闲端口。即使极小概率抽到受保护端口，也立即关闭重抽。
 */
export async function startFixture(token: string): Promise<FixtureServer> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      response.setHeader('cache-control', 'no-store');
      if (url.pathname === '/favicon.ico') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname !== '/fixture') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      const html = fixtureHtml(token);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('content-length', Buffer.byteLength(html));
      response.end(html);
    });
    const port = await listen(server);
    if (PROTECTED_PORTS.has(port)) {
      await closeServer(server);
      continue;
    }
    return { server, port, url: `http://127.0.0.1:${port}/fixture?run=${token}` };
  }
  throw new Error('本地 fixture 连续抽到受保护端口，无法安全启动');
}
