// Verify the published index URLs serve exactly the committed bytes.
//
// DSH refuses a source that redirects or does not answer 2xx, so for every required URL this
// asserts: status 200, location absent, byte length identical to the local file, sha256
// identical. Raw GitHub content lags a fresh push by up to a couple of minutes, so required
// URLs are retried.
//
// Usage:
//   node tools/check-live.mjs --file=index.json \
//     --require=https://raw.githubusercontent.com/OWNER/REPO/main/index.json \
//     --optional=https://OWNER.github.io/REPO/index.json \
//     [--retries=9] [--delay-ms=20000]
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

const FILE = path.resolve(one('file', path.join(ROOT, 'index.json')));
const REQUIRED = collected.get('require') ?? [];
const OPTIONAL = collected.get('optional') ?? [];
const RETRIES = Number(one('retries', 9));
const DELAY_MS = Number(one('delay-ms', 20000));

const local = await readFile(FILE);
const wantedSha = createHash('sha256').update(local).digest('hex');
console.log(`local file: ${FILE} (${local.length} bytes, sha256 ${wantedSha})`);
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
  const sha = createHash('sha256').update(body).digest('hex');
  if (body.length !== local.length || sha !== wantedSha) {
    return { ok: false, detail: `content mismatch: ${body.length} bytes / sha256 ${sha}` };
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
  console.error(`FAIL: required URL never served the committed bytes: ${url}`);
  failed = true;
}

for (const url of OPTIONAL) {
  const result = await probe(url);
  console.log(`  ${result.ok ? '✓' : '…'} optional: ${url} — ${result.detail}`);
  if (result.ok === false && /HTTP 404/u.test(result.detail)) {
    console.log('    (optional URL not published yet — enable GitHub Pages, or ignore: the required URLs already work)');
  }
}

if (failed) {
  console.error('\nFAIL: the published index does not match the committed bytes yet.');
  process.exit(1);
}
console.log('\nOK: every required URL serves the committed bytes, with no redirect.');
