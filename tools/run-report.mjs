// Write run-report.json (a committed heartbeat proving a scheduled run happened) and append a
// human-readable summary to the workflow run page.
//
// Usage: node tools/run-report.mjs [--out-dir=DIR]
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/u, ''), v ?? 'true'];
  }),
);
const OUT_DIR = path.resolve(argv.get('out-dir') ?? ROOT);

const indexRaw = await readFile(path.join(OUT_DIR, 'index.json'));
const stats = JSON.parse(await readFile(path.join(OUT_DIR, 'stats.json'), 'utf8'));
const doc = JSON.parse(indexRaw.toString('utf8'));
const versions = doc.plugins.reduce((sum, p) => sum + p.versions.length, 0);

const repository = process.env.GITHUB_REPOSITORY ?? 'dingdang66686/dsh-market-index';
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const report = {
  generatedAt: new Date().toISOString(),
  repository,
  runId,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? 'local',
  runUrl: runId === 'local' ? null : `${serverUrl}/${repository}/actions/runs/${runId}`,
  triggeredBy: process.env.GITHUB_EVENT_NAME ?? 'local',
  commit: (process.env.GITHUB_SHA ?? '').slice(0, 7) || null,
  runner: process.env.RUNNER_OS ? `${process.env.RUNNER_OS} ${process.env.RUNNER_ARCH ?? ''}`.trim() : 'local',
  node: process.version,
  catalog: { url: stats.catalogUrl, updated: stats.catalogUpdated ?? null, entries: stats.catalogEntries },
  index: {
    bytes: indexRaw.length,
    sha256: createHash('sha256').update(indexRaw).digest('hex'),
    plugins: doc.plugins.length,
    versions,
    categories: Object.keys(doc.metadata.categories).length,
    labels: Object.keys(doc.metadata.labels).length,
  },
  crawl: {
    npmCandidates: stats.npmCandidates,
    withoutPackument: stats.noCache,
    notFoundOnNpm: stats.notFoundOnNpm,
    noUsableVersion: stats.noUsableVersion,
    previousPlugins: stats.previousPlugins ?? null,
  },
};

await writeFile(path.join(OUT_DIR, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  '## DSH market index rebuilt',
  '',
  '| | |',
  '| --- | --- |',
  `| plugins | ${report.index.plugins} (previous run: ${report.crawl.previousPlugins ?? 'n/a'}) |`,
  `| versions | ${report.index.versions} |`,
  `| size | ${report.index.bytes} bytes |`,
  `| sha256 | \`${report.index.sha256}\` |`,
  `| catalog | ${report.catalog.entries} entries, updated ${report.catalog.updated ?? 'unknown'} |`,
  `| npm candidates | ${report.crawl.npmCandidates} (missing packument: ${report.crawl.withoutPackument}, 404: ${report.crawl.notFoundOnNpm}) |`,
  `| runner | ${report.runner}, ${report.node} |`,
  '',
];
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
} else {
  console.log(lines.join('\n'));
}
console.log(`wrote ${path.join(OUT_DIR, 'run-report.json')}: ${report.index.plugins} plugins / ${versions} versions`);
