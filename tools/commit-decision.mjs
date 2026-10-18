#!/usr/bin/env node
/**
 * Decide whether the current run should create a commit.
 *
 * `index.json` is deterministic, but `stats.json` and `run-report.json` carry a timestamp, so
 * committing on every run would add pure churn (two commits a day even when nothing changed).
 * Skipping every run is not an option either: GitHub disables a scheduled workflow in a
 * repository that sees no activity for 60 days, so the pipeline needs a heartbeat.
 *
 * Rules:
 *   - the index changed                                -> commit (this is the real payload)
 *   - no previous run report in the repository         -> commit (first run / schema upgrade)
 *   - that report is older than --max-report-age-days  -> commit (heartbeat, keeps the cron alive)
 *   - otherwise                                        -> skip
 *
 * Pure computation: the caller passes the previous report file (dumped with
 * `git show HEAD:run-report.json`), so this script never has to run git itself.
 *
 * Prints "commit: <reason>" or "skip: <reason>" on stdout, and writes the decision to
 * $GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY when those are set.
 */
import { appendFileSync, readFileSync } from 'node:fs';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

const indexChanged = arg('index-changed', '0') === '1';
const maxReportAgeDays = Number(arg('max-report-age-days', '7'));
const previousReportPath = arg('previous-report', '');

/** Age of the previously committed run report in days, or null when unavailable. */
function previousReportAgeDays() {
  if (!previousReportPath) return null;
  let generatedAt;
  try {
    ({ generatedAt } = JSON.parse(readFileSync(previousReportPath, 'utf8')));
  } catch {
    return null;
  }
  const at = Date.parse(generatedAt);
  return Number.isFinite(at) ? (Date.now() - at) / 86_400_000 : null;
}

const ageDays = previousReportAgeDays();
let decision;
let reason;

if (indexChanged) {
  [decision, reason] = ['commit', 'index.json changed'];
} else if (ageDays === null) {
  [decision, reason] = ['commit', 'no previous run report in the repository'];
} else if (ageDays >= maxReportAgeDays) {
  [decision, reason] = [
    'commit',
    `index unchanged, but the committed run report is ${ageDays.toFixed(1)} days old (>= ${maxReportAgeDays})`,
  ];
} else {
  [decision, reason] = [
    'skip',
    `index unchanged and the committed run report is only ${ageDays.toFixed(1)} days old`,
  ];
}

const line = `${decision}: ${reason}`;
console.log(line);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- commit decision: **${line}**\n`);
}
