// Build a format-1 plugin market index from the cached catalog + npm packuments.
//
// Usage: node tools/build-index.mjs [--out-dir=DIR] [--cache-dir=DIR] [--catalog-file=FILE]
//                                  [--min-ratio=0.9] [--allow-shrink]
//
// Two safety gates keep a bad run from publishing a degraded index:
//   * noCache       - candidates whose packument is missing (network trouble upstream)
//   * shrink guard  - the new index may not lose more than --min-ratio of the previous plugins
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json';

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/u, ''), v ?? 'true'];
  }),
);

const CACHE = path.resolve(argv.get('cache-dir') ?? path.join(ROOT, 'cache'));
const CATALOG_FILE = path.resolve(argv.get('catalog-file') ?? path.join(ROOT, 'catalog.json'));
const OUT_DIR = path.resolve(argv.get('out-dir') ?? ROOT);
const OUT = path.join(OUT_DIR, 'index.json');
const MIN_RATIO = Number(argv.get('min-ratio') ?? 0.9);
const ALLOW_SHRINK = argv.get('allow-shrink') === 'true';

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const SAFE_RANGE_RE = /^(?:[\^~]|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*(?:[\^~]|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*$/u;
const MAX_VERSIONS_PER_PLUGIN = 6;
const MAX_DESCRIPTION = 600;

// ---- labels: the catalog's capability vocabulary, plus the two risk flags worth surfacing ----
const LABELS = {
  'fs-read': { en: 'Reads files', zh: '读取文件' },
  'fs-write': { en: 'Writes files', zh: '写入文件' },
  env: { en: 'Environment variables', zh: '环境变量' },
  network: { en: 'Network access', zh: '网络访问' },
  llm: { en: 'Calls a model', zh: '调用模型' },
  shell: { en: 'Shell commands', zh: '执行命令' },
  subagent: { en: 'Subagents', zh: '子代理' },
  credentials: { en: 'Credential access', zh: '访问凭据' },
  'dynamic-code': { en: 'Dynamic code', zh: '动态代码' },
  'host-runtime': { en: 'Host runtime', zh: '宿主运行时' },
  redline: { en: 'Highest-risk capability mix', zh: '最高风险能力组合' },
};

const SORT_KEYS = {
  stars: { title: l10n('GitHub stars', 'GitHub 星标'), order: 'desc' },
  downloads: { title: l10n('npm downloads (30d)', 'npm 下载量（30 天）'), order: 'desc' },
};

function compareVersions(a, b) {
  const parse = (v) => {
    const [core] = v.split('+');
    const [release, pre] = core.split('-');
    return { nums: release.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i];
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) - Number(r);
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

const secondsOf = (iso) => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
};

const clean = (text, max) => {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.replace(/\s+/gu, ' ').trim();
  if (trimmed === '') return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

// English is mandatory; Chinese is mirrored under both `zh` and the script-qualified `zh-hans`.
function l10n(en, zh) {
  return zh ? { en, zh, 'zh-hans': zh } : { en };
}

const catalog = JSON.parse(await readFile(CATALOG_FILE, 'utf8'));
const catalogVersion = new Map();
for (const entry of catalog.plugins) {
  if (NAME_RE.test(String(entry.npm ?? ''))) catalogVersion.set(entry.npm, entry);
}

const categories = {};
for (const [id, titles] of Object.entries(catalog.categories ?? {})) {
  const en = clean(titles?.en, 80) ?? id;
  const zh = clean(titles?.zh, 80);
  categories[id] = { title: l10n(en, zh) };
}
const declaredCategories = new Set(Object.keys(categories));

const plugins = [];
const stats = {
  catalogEntries: catalog.plugins.length,
  npmCandidates: catalogVersion.size,
  noCache: 0,
  notFoundOnNpm: 0,
  noUsableVersion: 0,
  included: 0,
  versionsTotal: 0,
  versionsWithoutDshField: 0,
  catalogVersionMismatch: 0,
  unparsable: 0,
};

for (const [name, entry] of catalogVersion.entries()) {
  const file = path.join(CACHE, `${name.replace('/', '__')}.json.gz`);
  let packument;
  try {
    packument = JSON.parse(gunzipSync(await readFile(file)).toString('utf8'));
  } catch {
    stats.noCache += 1;
    continue;
  }
  if (packument.__status === 404) {
    stats.notFoundOnNpm += 1;
    continue;
  }
  const manifests = packument.versions ?? {};
  const times = packument.time ?? {};
  const fallbackSeconds = secondsOf(`${entry.added}T00:00:00Z`);

  const published = Object.keys(manifests).filter((v) => SEMVER_RE.test(v));
  const withDsh = published.filter((v) => manifests[v] && typeof manifests[v] === 'object' && manifests[v].dsh !== undefined && !manifests[v].deprecated);
  let chosen = withDsh;
  if (chosen.length === 0) {
    chosen = manifests[entry.version] && !manifests[entry.version].deprecated ? [entry.version] : [];
  }
  if (entry.version && !manifests[entry.version]) stats.catalogVersionMismatch += 1;

  chosen = chosen.sort(compareVersions).reverse().slice(0, MAX_VERSIONS_PER_PLUGIN);

  const versions = [];
  for (const version of chosen) {
    const manifest = manifests[version] ?? {};
    const publishTimestamp = secondsOf(times[version]) ?? (version === entry.version ? fallbackSeconds : undefined);
    if (publishTimestamp === undefined) continue;
    if (manifest.dsh === undefined) stats.versionsWithoutDshField += 1;
    const range = manifest.engines?.dsh;
    const engines = typeof range === 'string' && !range.startsWith('workspace:') && SAFE_RANGE_RE.test(range.trim()) ? { dsh: range.trim() } : undefined;
    versions.push({
      version,
      publishTimestamp,
      source: { type: 'npm' },
      ...(engines ? { engines } : {}),
    });
  }
  if (versions.length === 0) {
    stats.noUsableVersion += 1;
    continue;
  }

  const description = entry.description ?? {};
  const en = clean(description.en, MAX_DESCRIPTION) ?? clean(description.zh, MAX_DESCRIPTION);
  const zh = clean(description.zh, MAX_DESCRIPTION);
  const labels = Object.keys(LABELS).filter((id) => {
    if (id === 'redline') {
      return (entry.capabilityRedLines ?? []).some((line) => /credentials\/secrets AND has network access|install time/u.test(String(line)));
    }
    return (entry.capabilities ?? []).includes(id);
  });
  const redlines = entry.capabilityRedLines ?? [];
  const capabilities = (entry.capabilities ?? []).filter((k) => typeof k === 'string');
  const keywords = [...new Set([...capabilities, ...(redlines.length > 0 ? ['redline'] : [])])];
  const sortKeys = {};
  if (typeof entry.stars === 'number' && Number.isFinite(entry.stars)) sortKeys.stars = entry.stars;
  if (typeof entry.downloads === 'number' && Number.isFinite(entry.downloads)) sortKeys.downloads = entry.downloads;

  try {
    plugins.push({
      name,
      title: clean(entry.name, 120) ?? name,
      ...(en ? { description: l10n(en, zh) } : {}),
      icon: `https://github.com/${String(entry.owner).replace(/[^A-Za-z0-9-]/gu, '')}.png`,
      author: clean(entry.owner, 80),
      homepage: entry.url,
      repository: { url: entry.url },
      metadata: {
        ...(declaredCategories.has(entry.category) ? { category: entry.category } : {}),
        keywords,
        labels,
        sortKeys,
      },
      versions,
    });
    stats.included += 1;
    stats.versionsTotal += versions.length;
  } catch (err) {
    stats.unparsable += 1;
    if (stats.unparsable < 6) console.log(`  skip ${name}: ${err.message}`);
  }
}

const count = plugins.length;
const index = {
  format: 1,
  title: l10n('DSH Community Plugins (awesome-dsh-plugin)', `DSH 社区插件市场 · awesome-dsh-plugin（${count}）`),
  description: l10n(
    `Format-1 index generated from the ${catalog.plugins.length}-entry awesome-dsh-plugin catalog (${count} npm-published bundles). Independent community snapshot, not affiliated with DeepSeek; entries are not security-reviewed.`,
    `由 awesome-dsh-plugin 目录（${catalog.plugins.length} 条）生成的 format 1 索引，收录其中 ${count} 个已发布到 npm 的插件包。社区快照，与 DeepSeek 官方无关，条目未经安全审计。`,
  ),
  metadata: {
    categories,
    labels: Object.fromEntries(Object.entries(LABELS).map(([id, title]) => [id, { title: l10n(title.en, title.zh) }])),
    sortKeys: SORT_KEYS,
  },
  plugins,
};

// ---- safety gates ----
const missingLimit = Math.max(5, Math.ceil(stats.npmCandidates * 0.01));
if (stats.noCache > missingLimit) {
  console.error(
    `FAIL: ${stats.noCache} of ${stats.npmCandidates} candidates have no cached packument ` +
      `(allowed ${missingLimit}). The npm crawl was incomplete; refusing to publish a degraded index.\n` +
      'Re-run the crawl (it is resumable) or pass --allow-shrink to override.',
  );
  process.exit(2);
}

let previousCount = 0;
try {
  const previous = JSON.parse(await readFile(OUT, 'utf8'));
  previousCount = Array.isArray(previous.plugins) ? previous.plugins.length : 0;
} catch {
  previousCount = 0;
}
if (!ALLOW_SHRINK && previousCount > 0 && count < previousCount * MIN_RATIO) {
  console.error(
    `FAIL: new index has ${count} plugins, previous had ${previousCount} ` +
      `(floor ${Math.floor(previousCount * MIN_RATIO)}). Refusing to publish a suspicious shrink.\n` +
      'Check the crawl output, or pass --allow-shrink if the drop is expected.',
  );
  process.exit(3);
}

await mkdir(OUT_DIR, { recursive: true });
const text = JSON.stringify(index);
const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
await writeFile(OUT, text);
await writeFile(
  path.join(OUT_DIR, 'stats.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      catalogUrl: CATALOG_URL,
      catalogUpdated: catalog.updated,
      outputBytes: Buffer.byteLength(text),
      sha256,
      previousPlugins: previousCount,
      ...stats,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${OUT} (${(Buffer.byteLength(text) / 1048576).toFixed(2)} MiB, sha256 ${sha256})`);
console.log(JSON.stringify(stats, null, 2));
