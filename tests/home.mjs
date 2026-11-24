import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { legacyContestTarget, parseContestCatalog } from '../docs/home.mjs';

const root = new URL('../docs/', import.meta.url);
const archive = new URL('contests/2026-11-22/', root);
const historical = {
  public_slug: '2026-11-22', title: 'Первый конкурс', prize: 'Антенна',
  phase: 'DRAWN', date: '2026-11-22',
};
const upcoming = {
  public_slug: '2026-12-04-example', title: 'Следующий конкурс', prize: 'Приз',
  phase: 'ANNOUNCED', date: '2026-12-05',
};
const catalog = (...contests) => ({ schema_version: 'meshdraw-contest-catalog-v1', contests });

test('catalog groups public phases independently of a rescheduled contest date', () => {
  const active = { ...upcoming, public_slug: '2026-12-01-active', phase: 'OPEN', date: '2026-12-02' };
  const ended = { ...upcoming, public_slug: '2026-12-01-ended', phase: 'CANCELLED', date: '2026-12-01' };
  assert.deepEqual(parseContestCatalog(catalog(upcoming, historical, active, ended)), {
    current: [active, upcoming],
    archived: [ended, historical],
  });
});

test('catalog rejects duplicate paths, invalid dates and unapproved fields', () => {
  assert.throws(() => parseContestCatalog(catalog(upcoming, upcoming)), /CATALOG_ENTRY/);
  for (const change of [
    { public_slug: '../2026-12-04-example' },
    { public_slug: '2026-02-30-example' },
    { public_slug: '2026-12-04-example\n' },
    { public_slug: '2026-12-04' },
    { date: '2026-13-01' },
    { contest_id: 'private-id' },
    { href: 'https://example.test/' },
    { phase: 'DRAFT' },
  ]) {
    assert.throws(() => parseContestCatalog(catalog({ ...upcoming, ...change })), /CATALOG_ENTRY/);
  }
});

test('legacy links keep their exact archived section and the new catalog remains on root', async () => {
  const index = await readFile(new URL('index.html', archive), 'utf8');
  for (const fragment of ['#verification', '#rules-section', '#tickets-section', '#method', '#saved-result']) {
    assert.equal(legacyContestTarget(fragment), `./contests/2026-11-22/${fragment}`);
    assert.ok(index.includes(`id="${fragment.slice(1)}"`));
  }
  for (const fragment of ['', '#main', '#contests', '#archive', '#about', '#//example.test']) {
    assert.equal(legacyContestTarget(fragment), null);
  }
});

test('historical archive and direct evidence URLs retain all published bytes', async () => {
  const archiveManifest = await readFile(new URL('SHA256SUMS.json', archive));
  assert.deepEqual(archiveManifest, await readFile(new URL('SHA256SUMS.json', root)));
  const manifest = JSON.parse(archiveManifest.toString());
  const members = await readdir(archive, { recursive: true, withFileTypes: true });
  const topFiles = members.filter((member) => member.isFile()).length;
  assert.equal(topFiles, Object.keys(manifest).length + 1);
  for (const [name, digest] of Object.entries(manifest)) {
    const payload = await readFile(new URL(name, archive));
    assert.equal(createHash('sha256').update(payload).digest('hex'), digest, name);
    if (name !== 'index.html') {
      assert.deepEqual(payload, await readFile(new URL(name, root)), name);
    }
  }
});
