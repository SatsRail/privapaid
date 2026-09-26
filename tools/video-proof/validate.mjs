import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { decryptObject, importRoot } from './format.mjs';
import { publicFixtureKey, sha256 } from './encrypt.mjs';

const { values } = parseArgs({ options: { fixture: { type: 'string' } } });
if (!values.fixture) throw new Error('Provide --fixture <generated-directory>');
const dir = resolve(values.fixture);
const fixture = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
assert.equal(fixture.complete, true); assert.equal(fixture.synthetic, true);
const root = await importRoot(publicFixtureKey(fixture.version));
async function plaintext(object) {
  const blob = await readFile(join(dir, object.name));
  assert.equal(sha256(blob), object.encryptedSha256);
  const data = await decryptObject(blob, root, fixture.asset, fixture.version, object.name);
  assert.equal(sha256(data), object.sha256);
  return data;
}
const report = { fixture: fixture.version, validatedAt: new Date().toISOString(), tracks: [] };
for (const track of [0, 1]) {
  const objects = fixture.objects.filter(o => o.name === `init-${track}.mp4` || o.name.startsWith(`segment-${track}-`));
  assert.equal(objects[0]?.name, `init-${track}.mp4`);
  const probe = spawn(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'compact=p=0', '-i', 'pipe:0'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(probe, 'close');
  let stderr = ''; probe.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const input = pipeline(Readable.from((async function* () {
    for (const object of objects) yield Buffer.from(await plaintext(object));
  })()), probe.stdin);
  let previousEnd, first, end, packets = 0, keyframes = 0, maxGap = 0;
  for await (const line of createInterface({ input: probe.stdout })) {
    const fields = Object.fromEntries(line.split('|').map(s => s.split('=')));
    if (!fields.pts_time) continue;
    const pts = Number(fields.pts_time), duration = Number(fields.duration_time);
    assert.ok(Number.isFinite(pts) && Number.isFinite(duration));
    if (previousEnd !== undefined) maxGap = Math.max(maxGap, Math.abs(pts - previousEnd));
    first ??= pts; end = pts + duration; previousEnd = end; packets++;
    if (fields.flags?.includes('K')) keyframes++;
  }
  await input;
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.ok(packets > 0);
  assert.ok(maxGap < 0.000003, `Track ${track} discontinuity: ${maxGap}s`);
  assert.ok(Math.abs(end - fixture.seconds) < 0.1, `Track ${track} duration: ${end}`);
  if (track === 0) {
    assert.equal(packets, fixture.seconds * 24);
    assert.equal(keyframes, Math.ceil(fixture.seconds / fixture.segmentSeconds));
  }
  report.tracks.push({ track, packets, keyframes, first, end, maxGap, objects: objects.length });
}
await plaintext(fixture.objects.find(o => o.name === 'play.mpd'));
await writeFile(join(dir, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
