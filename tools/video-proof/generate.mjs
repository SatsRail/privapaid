import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { MAX_OBJECT_BYTES, objectContext } from './format.mjs';
import { encryptObject, publicFixtureKey, sha256 } from './encrypt.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, seconds: { type: 'string', default: '42' },
  segment: { type: 'string', default: '4' },
} });
if (!values.output) throw new Error('Provide --output <new-directory>');
const seconds = Number(values.seconds), segment = Number(values.segment);
if (!Number.isInteger(seconds) || seconds < 12 || seconds > 7202 || ![4, 10].includes(segment)) {
  throw new Error('Use 12–7202 seconds and a segment duration of 4 or 10');
}
const output = resolve(values.output);
await mkdir(output); // Refuse reuse: every run has fresh immutable identities.
const asset = randomUUID(), version = randomUUID(), key = publicFixtureKey(version);
const objects = [], pending = new Set(), names = new Set();
let manifest, failure;
const prefix = `/ingest/${randomUUID()}/`;
const server = createServer((req, res) => {
  const job = (async () => {
    try {
      if (req.method !== 'PUT' || !req.url.startsWith(prefix)) throw new Error('Invalid ingest request');
      const name = req.url.slice(prefix.length);
      objectContext(asset, version, name);
      const parts = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > MAX_OBJECT_BYTES) throw new Error('Object size limit');
        parts.push(part);
      }
      const plaintext = Buffer.concat(parts);
      // DASH may rewrite its manifest while encoding. Keep it only in RAM and
      // encrypt the final manifest once, after successful FFmpeg completion.
      if (name === 'play.mpd') manifest = plaintext;
      else {
        if (names.has(name)) throw new Error('Attempt to overwrite immutable object');
        names.add(name);
        const encrypted = encryptObject(plaintext, key, asset, version, name);
        await writeFile(join(output, name), encrypted, { flag: 'wx', mode: 0o600 });
        objects.push({ name, bytes: plaintext.length, sha256: sha256(plaintext),
          encryptedBytes: encrypted.length, encryptedSha256: sha256(encrypted) });
      }
      res.writeHead(200); res.end();
    } catch (error) {
      failure = error;
      res.writeHead(400); res.end('Invalid fixture ingest');
    }
  })();
  pending.add(job); job.finally(() => pending.delete(job));
});
server.requestTimeout = 30_000;
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-map', '0:v', '-map', '1:a', '-t', String(seconds),
  '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level:v', '3.0',
  '-g', String(segment * 24), '-keyint_min', String(segment * 24), '-sc_threshold', '0', '-bf', '0',
  '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
  '-f', 'dash', '-seg_duration', String(segment), '-use_template', '1', '-use_timeline', '1',
  '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
  '-init_seg_name', 'init-$RepresentationID$.mp4',
  '-media_seg_name', 'segment-$RepresentationID$-$Number%05d$.m4s',
  '-method', 'PUT', '-timeout', '10',
  `http://127.0.0.1:${server.address().port}${prefix}play.mpd`];
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const start = performance.now();
try {
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const [code] = await once(child, 'close');
  await Promise.all(pending);
  if (code !== 0 || failure || !manifest) throw failure || new Error(`FFmpeg ${code}: ${stderr}`);
  const encrypted = encryptObject(manifest, key, asset, version, 'play.mpd');
  await writeFile(join(output, 'play.mpd'), encrypted, { flag: 'wx', mode: 0o600 });
  objects.push({ name: 'play.mpd', bytes: manifest.length, sha256: sha256(manifest),
    encryptedBytes: encrypted.length, encryptedSha256: sha256(encrypted) });
  objects.sort((a, b) => a.name.localeCompare(b.name));
  const evidence = { format: 'PPV0-experimental', synthetic: true, publicFixtureKey: true,
    asset, version, seconds, segmentSeconds: segment, objects,
    generatedAt: new Date().toISOString(), generationSeconds: (performance.now() - start) / 1000,
    node: process.version, ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n').slice(0, 3),
    ffmpegArgs: [...args.slice(0, -1), '<loopback-encrypting-sink>/play.mpd'],
    processMemory: process.memoryUsage(), complete: true };
  await writeFile(join(output, 'fixture.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, objects: objects.length, seconds, segment,
    generationSeconds: evidence.generationSeconds, rss: evidence.processMemory.rss }));
} finally {
  key.fill(0);
  server.closeAllConnections();
  await new Promise(ok => server.close(ok));
}
