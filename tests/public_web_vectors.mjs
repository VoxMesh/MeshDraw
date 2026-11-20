// The same Python-generated synthetic packages run in Node and in a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as verifier from '../docs/verifier.mjs';
import {announcementClock} from '../docs/announcement.mjs';

const location = './fixtures/synthetic/browser-vectors.json';
const fixtures = JSON.parse(await readFile(new URL(location, import.meta.url), 'utf8'));
assert.equal(fixtures.mode, 'SYNTHETIC');
assert.equal(fixtures.schema_version, 'meshdraw-browser-vectors-v1');
for (const vector of fixtures.vectors) {
  test(vector.name, async () => {
    const result = await verifier.verifyPackage(vector.package);
    assert.equal(result.status, 'MATCH');
    assert.equal(result.provenance, 'NOT_INDEPENDENTLY_CONFIRMED');
    assert.deepEqual(result.selection, vector.package.expected.selection);
    assert.deepEqual(result.calculation, vector.package.expected.calculation);
  });
}
for (const vector of fixtures.mapping_vectors) {
  test(vector.name, async () => {
    assert.deepEqual(await verifier.mapDigest(vector.root_hex, vector.tickets, vector.max_words), vector.expected);
  });
}

test('changed RF input is rejected before a match can be claimed', async () => {
  const changed = structuredClone(fixtures.vectors[0].package);
  const observation = changed.snapshot.rows.find(row => row.layer === 'observation');
  observation.fields.rssi.value = '-123.25';
  await assert.rejects(verifier.verifyPackage(changed));
});

test('a changed declared winner is not used as the computed answer', async () => {
  const changed = structuredClone(fixtures.vectors[0].package);
  changed.expected.calculation.mapping.ticket = '99999999';
  changed.manifest.expected = await verifier.digest(changed.expected);
  await assert.rejects(verifier.verifyPackage(changed), /CALCULATION_MISMATCH/);
});

test('JSON parser rejects duplicate keys and unsafe numeric literals', () => {
  assert.throws(() => verifier.parsePackageText('{"a":1,"a":2}'));
  assert.throws(() => verifier.parsePackageText('{"id":9007199254740993}'));
});

const clockSchedule = {
  cutoff: new Date('2026-11-21T17:00:00Z'),
  ceremony: new Date('2026-11-22T16:00:00Z'),
};
const clockState = {
  synthetic: true,
  phase: 'OPEN',
  opens_at: '2026-11-01T00:00:00Z',
  snapshot_at: '2026-11-20T00:00:00Z',
  cutoff_at: clockSchedule.cutoff.toISOString(),
  archive_plan: null,
};

test('announcement clock switches deadlines at the registration cutoff', () => {
  for (const [now, label, seconds] of [
    ['2026-11-21T16:59:59Z', 'До окончания приёма заявок', 1],
    ['2026-11-21T17:00:00Z', 'До запланированного подведения итогов', 82_800],
    ['2026-11-21T17:00:05Z', 'До запланированного подведения итогов', 82_795],
    ['2026-11-22T15:59:59Z', 'До запланированного подведения итогов', 1],
  ]) {
    assert.deepEqual(announcementClock(clockState, clockSchedule, Date.parse(now)), {label, seconds}, now);
  }
  assert.deepEqual(announcementClock(clockState, clockSchedule, +clockSchedule.cutoff - 1), {
    label: 'До окончания приёма заявок', seconds: 1,
  });
});

test('elapsed ceremony time waits for a published result without a zero countdown', () => {
  for (const now of [+clockSchedule.ceremony, +clockSchedule.ceremony + 5_000]) {
    assert.deepEqual(announcementClock(clockState, clockSchedule, now), {
      label: 'Ожидаем опубликованного проверенного результата', seconds: null,
    });
  }
});

test('announcement clock follows closing phases and yields to the frozen plan', () => {
  const now = +clockSchedule.cutoff - 1_000;
  for (const phase of ['CLOSING', 'CLOSED', 'DRAINED']) {
    assert.deepEqual(announcementClock({...clockState, phase}, clockSchedule, now), {
      label: 'До запланированного подведения итогов', seconds: 82_801,
    });
  }
  for (const phase of ['FROZEN', 'WAITING', 'RUNNING', 'DRAWN', 'DRAW_FAILED', 'UNKNOWN']) {
    assert.equal(announcementClock({...clockState, phase}, clockSchedule, now), null, phase);
  }
  assert.equal(announcementClock({...clockState, archive_plan: {}}, clockSchedule, now), null);
});

test('announcement clock avoids misleading displays when data or client time is invalid', () => {
  const now = +clockSchedule.cutoff - 1_000;
  assert.equal(announcementClock(null, clockSchedule, now), null);
  assert.equal(announcementClock({...clockState, snapshot_at: '2026-10-31T00:00:00Z'}, clockSchedule,
    Date.parse(clockState.opens_at) - 1), null);
  assert.equal(announcementClock({...clockState, cutoff_at: '2026-11-21T18:00:00Z'}, clockSchedule, now), null);
  assert.equal(announcementClock(clockState, {...clockSchedule, cutoff: new Date(NaN)}, now), null);
  assert.equal(announcementClock(clockState, {...clockSchedule, ceremony: clockSchedule.cutoff}, now), null);
  for (const clientTime of [NaN, Infinity, -Infinity, Date.parse(clockState.snapshot_at) - 1]) {
    assert.deepEqual(announcementClock(clockState, clockSchedule, clientTime), {
      label: 'Проверьте дату и время на устройстве', seconds: null,
    });
  }
});

test('announcement clock uses the supplied schedule rather than fixed calendar dates', () => {
  const schedule = {cutoff: Date.parse('2030-07-01T12:00:00Z'), ceremony: Date.parse('2030-07-02T12:00:00Z')};
  const state = {...clockState, cutoff_at: new Date(schedule.cutoff).toISOString()};
  assert.deepEqual(announcementClock(state, schedule, schedule.cutoff - 123_000), {
    label: 'До окончания приёма заявок', seconds: 123,
  });
  assert.deepEqual(announcementClock(state, schedule, schedule.cutoff + 123_000), {
    label: 'До запланированного подведения итогов', seconds: 86_277,
  });
});
