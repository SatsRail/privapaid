import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publicFixtureKey } from './encrypt.mjs';
import { objectContext } from './format.mjs';

// Loopback-only lab. The /session key is PUBLIC synthetic fixture material.
// This is not a payment endpoint and cannot load arbitrary source media.
const here = dirname(fileURLToPath(import.meta.url));
export async function startServer(directory, port = 0) {
  const dir = resolve(directory);
  const fixture = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
  if (!fixture.complete || !fixture.synthetic || !fixture.publicFixtureKey || fixture.format !== 'PPV0-experimental') {
    throw new Error('Only completed synthetic PPV0 fixtures may be served');
  }
  const allowed = new Set(fixture.objects.map(o => {
    objectContext(fixture.asset, fixture.version, o.name);
    return o.name;
  }));
  const stats = { requests: 0, encryptedBytes: 0, objects: {} };
  const server = createServer(async (req, res) => {
    try {
      // Reject DNS rebinding and cross-origin access to the loopback lab.
      const expected = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expected || (req.headers.origin && req.headers.origin !== `http://${expected}`)) {
        res.writeHead(403); res.end(); return;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const path = req.url;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (path === '/session') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...fixture, key: publicFixtureKey(fixture.version).toString('base64') })); return;
      }
      if (path === '/stats') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(stats)); return;
      }
      const sources = {
        '/': ['index.html', 'text/html'], '/player.mjs': ['player.mjs', 'text/javascript'],
        '/format.mjs': ['format.mjs', 'text/javascript'],
        '/shaka.js': ['node_modules/shaka-player/dist/shaka-player.compiled.js', 'text/javascript'],
      };
      if (sources[path]) {
        const [file, type] = sources[path];
        res.setHeader('Content-Type', type); res.end(await readFile(join(here, file))); return;
      }
      const prefix = `/objects/${fixture.asset}/${fixture.version}/`;
      if (!path.startsWith(prefix) || !allowed.has(path.slice(prefix.length))) {
        res.writeHead(404); res.end(); return;
      }
      const name = path.slice(prefix.length), bytes = await readFile(join(dir, name));
      stats.requests++; stats.encryptedBytes += bytes.length;
      stats.objects[name] = (stats.objects[name] || 0) + 1;
      res.setHeader('Content-Type', name === 'play.mpd' ? 'application/dash+xml' : 'application/octet-stream');
      res.end(bytes);
    } catch {
      res.writeHead(500); res.end('Fixture unavailable');
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, fixture, stats };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { fixture: { type: 'string' }, port: { type: 'string', default: '4317' } } });
  if (!values.fixture) throw new Error('Provide --fixture <generated-directory>');
  const { url } = await startServer(values.fixture, Number(values.port));
  console.log(`Synthetic encrypted playback proof: ${url}`);
}
