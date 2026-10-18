// Validate a generated index with the REAL published @deepseek-ai/dsh-plugin-market-index
// parser, exactly as the DSH host reads it from a configured index source URL.
//
// Usage: node tools/validate-index.mjs [--file=index.json] [--url=<index source URL>]
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/u, ''), v ?? 'true'];
  }),
);

const FILE = path.resolve(argv.get('file') ?? path.join(ROOT, 'index.json'));
// Only used for resolving relative icon URLs; the host uses the URL the user added.
const INDEX_URL = argv.get('url') ?? 'https://cdn.jsdelivr.net/gh/dingdang66686/dsh-market-index@main/index.json';
const MAX_BYTES = 134217728; // the host's default limit, 128 MiB

// Resolve through the package's own exports map, then import by absolute file URL, so this
// works both for a node_modules install and for a locally linked checkout.
const require = createRequire(import.meta.url);
const entry = require.resolve('@deepseek-ai/dsh-plugin-market-index');
const { parseMarketIndex, marketInstallTarget, MarketIndexError } = await import(pathToFileURL(entry).href);

const raw = await readFile(FILE);
const sha256 = createHash('sha256').update(raw).digest('hex');
console.log(`file: ${FILE}`);
console.log(`bytes: ${raw.length} (limit ${MAX_BYTES}), sha256: ${sha256}`);
console.log(`index URL used for resolution: ${INDEX_URL}`);

if (raw.length > MAX_BYTES) {
  console.error(`FAIL: index is ${raw.length} bytes, over the host limit of ${MAX_BYTES} bytes.`);
  process.exit(1);
}

const doc = JSON.parse(raw.toString('utf8'));
if (doc.format !== 1) {
  console.error(`FAIL: $.format is ${JSON.stringify(doc.format)}, expected 1.`);
  process.exit(1);
}

const startedAt = Date.now();
let parsed;
try {
  parsed = parseMarketIndex(doc, INDEX_URL);
} catch (err) {
  if (err instanceof MarketIndexError) {
    console.error(`FAIL: INVALID: path=${err.path} reason=${err.reason}`);
    process.exit(1);
  }
  throw err;
}
const ms = Date.now() - startedAt;

// An index with no entries parses as format 1 but would show an empty market. Fail closed with an
// explicit path/reason instead of crashing on the sample lines below.
if (parsed.plugins.length === 0) {
  console.error('INVALID: path=$.plugins reason=must list at least one plugin');
  process.exit(1);
}

const versionCount = parsed.plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0);
console.log(`VALID format-1 index: ${parsed.plugins.length} plugins, ${versionCount} versions, parsed in ${ms} ms`);
console.log(`title: ${JSON.stringify(parsed.title)}`);
console.log(`description.en: ${parsed.description?.en?.slice(0, 160)}`);
console.log(
  `categories: ${Object.keys(parsed.metadata.categories).length}, ` +
    `labels: ${Object.keys(parsed.metadata.labels).length}, ` +
    `sortKeys: ${JSON.stringify(Object.keys(parsed.metadata.sortKeys))}`,
);

const categoryHistogram = {};
for (const plugin of parsed.plugins) {
  const id = plugin.metadata.category ?? '(none)';
  categoryHistogram[id] = (categoryHistogram[id] ?? 0) + 1;
}
console.log(`category coverage: ${JSON.stringify(Object.entries(categoryHistogram).sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
console.log(`entries carrying a declared sort key: ${parsed.plugins.filter((p) => Object.keys(p.metadata.sortKeys).length > 0).length}`);

// Install target: what Discover hands to the plugin manager.
const samples = [...new Set(['@anonyjcy/dsh-j-space', parsed.plugins[0]?.name, parsed.plugins[1]?.name].filter(Boolean))];
for (const sample of samples) {
  const plugin = parsed.plugins.find((p) => p.name === sample) ?? parsed.plugins[0];
  const version = plugin.versions[0];
  let target;
  try {
    target = marketInstallTarget(plugin.name, version);
  } catch (err) {
    target = `ERROR ${err.message}`;
  }
  console.log(
    `sample: ${plugin.name}@${version.version} published=${new Date(version.publishTimestamp * 1000).toISOString()} ` +
      `engines=${JSON.stringify(version.engines)} -> install target ${JSON.stringify(target)}`,
  );
}
console.log(`icon sample: ${parsed.plugins[0]?.icon}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Index validation',
      '',
      '| | |',
      '| --- | --- |',
      `| parser | \`@deepseek-ai/dsh-plugin-market-index\` |`,
      `| plugins | ${parsed.plugins.length} |`,
      `| versions | ${versionCount} |`,
      `| bytes | ${raw.length} / ${MAX_BYTES} |`,
      `| sha256 | \`${sha256}\` |`,
      '',
    ].join('\n'),
  );
}
