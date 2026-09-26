import { chromium, webkit } from 'playwright';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, browser: { type: 'string', default: 'chrome' },
  'skip-negative': { type: 'boolean', default: false },
  sample: { type: 'string', default: '0' },
} });
if (!values.fixture || !['chrome', 'webkit'].includes(values.browser)) {
  throw new Error('Use --fixture <directory> [--browser chrome|webkit]');
}
const sample = Number(values.sample);
assert.ok(Number.isInteger(sample) && sample >= 0 && sample <= 7201);
const { server, url, fixture, stats } = await startServer(values.fixture);
let browser;
const report = { fixture: fixture.version, browser: values.browser, started: new Date().toISOString(),
  mode: sample ? `sampled: first ${sample}s plus seeks` : 'full duration at 1x', checks: [], failures: [] };
try {
  assert.ok(sample < fixture.seconds);
  browser = await (values.browser === 'chrome'
    ? chromium.launch({ channel: 'chrome', headless: true })
    : webkit.launch({ headless: true }));
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(String(error)));
  await page.goto(url);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.proof.metrics.startupMs || window.proof.metrics.errors.length, null, { timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => window.proof.metrics.errors), []);
  await page.waitForFunction(sample => sample
    ? document.querySelector('video').currentTime >= sample
    : document.querySelector('video').ended, sample,
    { timeout: ((sample || fixture.seconds) + 30) * 1000 });
  report.playback = await page.evaluate(() => ({ ...window.proof.metrics,
    quality: document.querySelector('video').getVideoPlaybackQuality().toJSON?.() || {
      totalVideoFrames: document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames,
      droppedVideoFrames: document.querySelector('video').getVideoPlaybackQuality().droppedVideoFrames,
    }, duration: document.querySelector('video').duration,
    heap: performance.memory?.usedJSHeapSize || null }));
  assert.deepEqual(report.playback.errors, []);
  assert.ok(report.playback.frames > (sample || fixture.seconds) * 10, 'Actual frames must be decoded');
  assert.ok(Math.abs(report.playback.duration - fixture.seconds) < 0.1);
  assert.deepEqual(report.playback.waiting, [], 'Unexpected rebuffering during linear playback');
  assert.ok(report.playback.maxBufferedSpan < 60, 'Buffer should stay bounded');
  report.checks.push(sample ? 'sampled start playback' : 'linear playback to final fragment',
    'bounded playback buffer', 'no rebuffer events after startup');
  if (sample) {
    for (const time of [fixture.seconds / 2, fixture.seconds * 0.9]) {
      await page.evaluate(time => { const v = document.querySelector('video'); v.currentTime = time; v.play(); }, time);
      await page.waitForFunction(time => document.querySelector('video').currentTime > time + 1, time, { timeout: 10_000 });
    }
    report.checks.push('midpoint and 90% seeks');
  }
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 2; v.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 3, null, { timeout: 10_000 });
  await page.evaluate(() => document.querySelector('video').pause());
  const paused = await page.evaluate(() => document.querySelector('video').currentTime);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('video').currentTime), paused);
  await page.evaluate(end => { const v = document.querySelector('video'); v.currentTime = end - 2; v.play(); }, fixture.seconds);
  await page.waitForFunction(() => document.querySelector('video').ended, null, { timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.proof.metrics.errors), []);
  assert.deepEqual(consoleErrors, []);
  report.checks.push('backward/forward seeking', 'pause/resume');
  await page.screenshot({ path: join(resolve(values.fixture), `browser-${values.browser}.png`) });
  await page.close();
  if (!values['skip-negative']) {
    for (const attack of ['tag corruption', 'segment substitution']) {
      const bad = await browser.newPage();
      await bad.route('**/segment-0-00001.m4s', async route => {
        const response = await route.fetch(attack === 'segment substitution'
          ? { url: route.request().url().replace('00001.m4s', '00002.m4s') } : {});
        const body = await response.body();
        if (attack === 'tag corruption') body[body.length - 1] ^= 1;
        await route.fulfill({ response, body });
      });
      await bad.goto(url); await bad.locator('#start').click();
      await bad.waitForFunction(() => window.proof.metrics.errors.length > 0, null, { timeout: 20_000 });
      assert.equal(await bad.evaluate(() => window.proof.metrics.frames), 0, 'Corrupted first video fragment must not decode');
      report.checks.push(`${attack} rejected before first decoded frame`);
      await bad.close();
    }
  }
  assert.equal((await fetch(`${url}/session`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  report.checks.push('cross-origin fixture-session denial');
  report.passed = true;
} catch (error) {
  report.passed = false; report.failures.push(String(error)); process.exitCode = 1;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(ok => server.close(ok));
  report.delivery = { requests: stats.requests, encryptedBytes: stats.encryptedBytes, uniqueObjects: Object.keys(stats.objects).length };
  await writeFile(join(resolve(values.fixture), `browser-${values.browser}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
