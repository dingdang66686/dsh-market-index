// Verify the published index URLs serve exactly the freshly built bytes.
//
// DSH refuses a source that redirects or does not answer 2xx, so for every required URL this
// asserts: status 200, location absent, byte length identical to the expected build, sha256
// identical. Raw GitHub content lags a fresh push by up to a couple of minutes, so required
// URLs are retried.
//
// The expected bytes come from --expect-sha256/--expect-bytes (what the build job recorded for the
// file it pushed) when given, and from --file otherwise. Preferring the recorded digest removes a
// race: a checkout of `main` taken before the push would compare the published bytes against the
// previous build and fail on exactly the runs that changed the index.
//
// Optional URLs (the jsDelivr CDN, GitHub Pages) are reported and annotated, never fatal: their
// freshness depends on third-party caches we do not control.
//
// Usage:
//   node tools/check-live.mjs --file=index.json \
//     --require=https://raw.githubusercontent.com/OWNER/REPO/main/index.json \
//     --optional=https://OWNER.github.io/REPO/index.json \
//     [--retries=9] [--delay-ms=20000]
//   node tools/check-live.mjs --expect-sha256=<hex> --expect-bytes=<n> --require=...
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collected = new Map();
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=');
  const key = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/u, '');
  const value = eq === -1 ? 'true' : arg.slice(eq + 1);
  collected.set(key, [...(collected.get(key) ?? []), value]);
}
const one = (key, fallback) => collected.get(key)?.at(-1) ?? fallback;

const explicitFile = one('file', '');
const EXPECT_SHA = one('expect-sha256', '').trim().toLowerCase();
const EXPECT_BYTES = Number(one('expect-bytes', 0)) || 0;
const REQUIRED = collected.get('require') ?? [];
const OPTIONAL = collected.get('optional') ?? [];
const RETRIES = Number(one('retries', 9));
const DELAY_MS = Number(one('delay-ms', 20000));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let wantedSha;
let wantedBytes;
if (EXPECT_SHA) {
  if (!/^[0-9a-f]{64}$/u.test(EXPECT_SHA) || EXPECT_BYTES <= 0) {
    console.error(`INVALID: --expect-sha256 must be 64 hex characters and --expect-bytes a positive integer (got ${JSON.stringify(EXPECT_SHA)}, ${JSON.stringify(EXPECT_BYTES)})`);
    process.exit(1);
  }
  wantedSha = EXPECT_SHA;
  wantedBytes = EXPECT_BYTES;
  console.log(`expected build: ${wantedBytes} bytes, sha256 ${wantedSha} (recorded by the build job)`);
  if (explicitFile) {
    const local = await readFile(path.resolve(explicitFile));
    if (local.length !== wantedBytes || sha256(local) !== wantedSha) {
      console.error(`INVALID: ${explicitFile} does not match the recorded digest — the checkout is stale, so this comparison would be meaningless`);
      process.exit(1);
    }
    console.log(`cross-checked against the checkout: ${explicitFile} matches`);
  }
} else {
  const file = path.resolve(explicitFile || path.join(ROOT, 'index.json'));
  const local = await readFile(file);
  wantedSha = sha256(local);
  wantedBytes = local.length;
  console.log(`local file: ${file} (${wantedBytes} bytes, sha256 ${wantedSha})`);
}
console.log(`required URLs: ${REQUIRED.length}, optional URLs: ${OPTIONAL.length}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<{ok: boolean, detail: string}>} */
async function probe(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'manual', cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
  } catch (err) {
    return { ok: false, detail: `fetch failed: ${err.name}: ${err.message}` };
  }
  const location = res.headers.get('location');
  if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}${location ? ` -> ${location}` : ''}` };
  if (location) return { ok: false, detail: `HTTP 200 but redirects to ${location}` };
  const body = Buffer.from(await res.arrayBuffer());
  const sha = sha256(body);
  if (body.length !== wantedBytes || sha !== wantedSha) {
    return { ok: false, detail: `content mismatch: served ${body.length} bytes / sha256 ${sha}, expected ${wantedBytes} / ${wantedSha}` };
  }
  return { ok: true, detail: `200, no redirect, ${body.length} bytes, sha256 ${sha}` };
}

const pending = [...REQUIRED];
for (let attempt = 1; attempt <= Math.max(1, RETRIES) && pending.length > 0; attempt += 1) {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const url = pending[i];
    const result = await probe(url);
    if (result.ok) {
      console.log(`  ✓ ${url} — ${result.detail}`);
      pending.splice(i, 1);
    } else {
      console.log(`  attempt ${attempt}/${RETRIES}: ${url} — ${result.detail}`);
    }
  }
  if (pending.length > 0 && attempt < RETRIES) await sleep(DELAY_MS);
}

let failed = false;
for (const url of pending) {
  console.error(`FAIL: required URL never served the freshly built bytes: ${url}`);
  failed = true;
}

for (const url of OPTIONAL) {
  const result = await probe(url);
  console.log(`  ${result.ok ? '✓' : '…'} optional: ${url} — ${result.detail}`);
  if (!result.ok) {
    const hint = /HTTP 404/u.test(result.detail)
      ? 'optional URL not published yet — enable GitHub Pages, or ignore: the required URLs already work'
      : 'this cache serves an older build — jsDelivr keeps @main for up to 12 h and is only refreshed by its purge endpoint, so this never fails the run';
    console.log(`    (${hint})`);
    console.log(`::warning title=Optional index URL behind::${url} — ${result.detail}`);
  }
}

if (failed) {
  console.error('\nFAIL: the published index does not match the freshly built bytes yet.');
  process.exit(1);
}
console.log('\nOK: every required URL serves the freshly built bytes, with no redirect.');
