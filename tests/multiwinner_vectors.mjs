import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { digest, evaluateArchive, parsePackageText, windowFilter } from '../docs/verifier.mjs';
import { verifyMultiwinnerPackage } from '../docs/multiwinner-v1.mjs';

function fixture(name) {
  return parsePackageText(readFileSync(new URL(`./fixtures/synthetic/${name}`, import.meta.url), 'utf8'));
}

const vectors = fixture('multiwinner-vectors.json');

async function makePackage(vector) {
  const count = vector.winner_count ?? 10;
  const tickets = Array.from({length: vector.size}, (_, index) => String(index + 1).padStart(4, '0'));
  let archive = null;
  let evidence = null;
  if (vector.status === 'DRAWN') {
    evidence = fixture('verification.json');
    const {policy, snapshot} = evidence;
    policy.tickets = tickets;
    const {rows, selection} = windowFilter({source: {query: {since: policy.start, until: policy.end}}}, snapshot);
    const input = {schema_version: 'meshdraw-archive-input-v1', source_snapshot_sha256: await digest(snapshot),
      archive_timestamp_meaning: 'Published archive field, physical times unknown',
      download_time_meaning: 'request_utc is extraction metadata, never RF input',
      retained: 'unknown-not-provided', rows};
    policy.input_document_sha256_before_calculation = await digest(input);
    evidence.expected = {selection, calculation: await evaluateArchive(policy, input)};
    for (const section of ['policy', 'expected']) evidence.manifest[section] = await digest(evidence[section]);
    archive = {mode: evidence.mode, profile: policy.profile, start: policy.start, end: policy.end,
      plan_sha256: evidence.projection.original_plan_sha256};
  }
  const plan = {schema_version: 'meshdraw-pilot-plan-v3', contest_id: 'synthetic-multiwinner', tickets,
    winner_count: count, underfilled_policy: vector.policy, order_algorithm: 'meshdraw-reserve-sha256-v1', archive};
  plan.plan_sha256 = await digest(plan);
  const result = {schema_version: 'meshdraw-pilot-result-v2', contest_id: plan.contest_id,
    plan_sha256: plan.plan_sha256, winner_count: count, status: vector.status, ordered_tickets: [...vector.order],
    winner_tickets: vector.order.slice(0, count), reserve_tickets: vector.order.slice(count),
    rf_sha256: evidence?.expected.calculation.rf.sha256 ?? null};
  const pkg = {schema_version: 'meshdraw-public-verification-v3', plan, result, archive_verification: evidence,
    manifest: {plan: await digest(plan), result: await digest(result), archive_verification: await digest(evidence)}};
  return pkg;
}

test('one ticket for one prize needs no RF even when underfilled contests are cancelled', async () => {
  const pkg = await makePackage({size: 1, winner_count: 1, policy: 'NO_DRAW', status: 'AWARD_ALL', order: ['0001']});
  const verified = await verifyMultiwinnerPackage(pkg, {expectedPlanSha256: pkg.plan.plan_sha256});
  assert.deepEqual(verified.result.winner_tickets, ['0001']);
  assert.equal(verified.result.rf_sha256, null);
});

for (const vector of vectors) {
  test(vector.name, async () => {
    const pkg = await makePackage(vector);
    const checked = await verifyMultiwinnerPackage(pkg, {expectedPlanSha256: pkg.plan.plan_sha256});
    assert.equal(checked.status, 'MATCH');
    assert.deepEqual(checked.result, pkg.result);
  });
}

test('rejects a rehashed result when either the final reserves or the winner boundary change', async () => {
  for (const [left, right] of [[11, 12], [9, 10], [12, 0]]) {
    const pkg = await makePackage(vectors.at(-1));
    const order = pkg.result.ordered_tickets;
    [order[left], order[right]] = [order[right], order[left]];
    pkg.result.winner_tickets = order.slice(0, 10);
    pkg.result.reserve_tickets = order.slice(10);
    pkg.manifest.result = await digest(pkg.result);
    await assert.rejects(verifyMultiwinnerPackage(pkg), /MULTIWINNER_RESULT_MISMATCH/);
  }
});

test('rejects a package that disagrees with a separately known plan hash', async () => {
  const pkg = await makePackage(vectors.at(-1));
  await assert.rejects(verifyMultiwinnerPackage(pkg, {expectedPlanSha256: '0'.repeat(64)}), /MULTIWINNER_PLAN_HASH/);
});

test('rejects an archive committed under another window and unexpected evidence for an award without RF', async () => {
  const pkg = await makePackage(vectors.at(-1));
  const {plan_sha256, ...otherPlan} = pkg.plan;
  otherPlan.archive.start = '2030-01-01T01:04:00Z';
  otherPlan.archive.end = '2030-01-01T01:05:00Z';
  otherPlan.plan_sha256 = await digest(otherPlan);
  pkg.plan = otherPlan;
  pkg.manifest.plan = await digest(otherPlan);
  await assert.rejects(verifyMultiwinnerPackage(pkg), /MULTIWINNER_ARCHIVE_PLAN_MISMATCH/);

  const awardOnly = await makePackage(vectors[1]);
  awardOnly.archive_verification = pkg.archive_verification;
  awardOnly.manifest.archive_verification = await digest(pkg.archive_verification);
  await assert.rejects(verifyMultiwinnerPackage(awardOnly), /MULTIWINNER_UNEXPECTED_ARCHIVE/);
});
