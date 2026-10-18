// Crawl npm packuments for the npm-published entries of the awesome-dsh-plugin catalog.
//
// Resumable: every packument is cached gzipped under <root>/cache, so re-runs are cheap.
// In CI the workflow passes --fresh, because a cached packument would freeze a plugin's
// version list forever.
//
// Usage: node tools/crawl-packuments.mjs [--fresh] [--limit=N] [--concurrency=12]
//                                       [--cache-dir=DIR] [--catalog-file=FILE]
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const UA = { 'user-agent': 'dsh-market-index/1.0 (+https://github.com/dingdang66686/dsh-market-index)' };

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/u, ''), v ?? 'true'];
  }),
);

const CACHE = path.resolve(argv.get('cache-dir') ?? path.join(ROOT, 'cache'));
const CATALOG_FILE = path.resolve(argv.get('catalog-file') ?? path.join(ROOT, 'catalog.json'));
const FRESH = argv.get('fresh') === 'true';
const LIMIT = argv.has('limit') ? Number(argv.get('limit')) : Infinity;
const CONCURRENCY = Number(argv.get('concurrency') ?? 16);

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

const cachePath = (name) => path.join(CACHE, `${name.replace('/', '__')}.json.gz`);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function getCatalog() {
  if (!FRESH && (await exists(CATALOG_FILE))) return JSON.parse(await readFile(CATALOG_FILE, 'utf8'));
  const res = await fetch(CATALOG_URL, { headers: UA });
  if (!res.ok) throw new Error(`catalog ${CATALOG_URL} -> HTTP ${res.status}`);
  const text = await res.text();
  await writeFile(CATALOG_FILE, text);
  return JSON.parse(text);
}

async function fetchPackument(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await fetch(url, { headers: { ...UA, accept: 'application/json' }, signal: ctl.signal });
      if (res.status === 404) return { status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { status: 200, doc: JSON.parse(text), bytes: text.length };
    } catch (err) {
      if (attempt === 3) return { status: 0, error: `${err.name}: ${err.message}` };
      await new Promise((r) => setTimeout(r, attempt * 1500));
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, error: 'exhausted' };
}

await mkdir(CACHE, { recursive: true });
const catalog = await getCatalog();

const targets = catalog.plugins
  .filter((e) => NAME_RE.test(String(e.npm ?? '')) && SEMVER_RE.test(String(e.version ?? '')))
  .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

console.log(
  `catalog: ${catalog.plugins.length} entries; npm-published targets: ${targets.length} ` +
    `(concurrency ${CONCURRENCY}, fresh=${FRESH})`,
);

let cached = 0;
let fetched = 0;
let notFound = 0;
let failed = 0;
const failures = [];
const startedAt = Date.now();
let index = 0;
let done = 0;

async function worker() {
  for (;;) {
    const position = index;
    index += 1;
    if (position >= targets.length) return;
    const entry = targets[position];
    const name = entry.npm;
    const file = cachePath(name);
    if (!FRESH && (await exists(file))) {
      cached += 1;
    } else {
      const result = await fetchPackument(name);
      if (result.status === 200) {
        await writeFile(file, gzipSync(JSON.stringify(result.doc)));
        fetched += 1;
      } else if (result.status === 404) {
        await writeFile(file, gzipSync(JSON.stringify({ __status: 404 })));
        notFound += 1;
      } else {
        failed += 1;
        if (failures.length < 25) failures.push(`${name}: ${result.error}`);
      }
    }
    done += 1;
    if (done % 250 === 0 || done === targets.length) {
      const seconds = (Date.now() - startedAt) / 1000;
      console.log(
        `[${done}/${targets.length}] cached=${cached} fetched=${fetched} 404=${notFound} failed=${failed} ` +
          `${seconds.toFixed(0)}s (${(done / Math.max(seconds, 1)).toFixed(1)}/s)`,
      );
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));

console.log(
  `\ndone in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: ` +
    `cached=${cached} fetched=${fetched} 404=${notFound} failed=${failed}`,
);
for (const f of failures) console.log(`  failure: ${f}`);
if (failed > 0) {
  // Not fatal on its own: tools/build-index.mjs refuses to publish when too many candidates
  // are missing, which is the gate that actually protects the published index.
  console.log(`\n::warning::${failed} packument fetch(es) failed; the build step will refuse to publish if too many are missing.`);
}
