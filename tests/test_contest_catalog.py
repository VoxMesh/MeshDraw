"""Verify the public descriptor contract independently of the browser."""

import json
import os
from pathlib import Path
import tempfile
import unittest

from tools.build_contest_catalog import catalog, validate_entry


def descriptor(slug, **fields):
    return {'public_slug': slug, 'title': 'Учебный конкурс', 'prize': 'Учебный приз',
            'phase': 'ANNOUNCED', **fields}


class ContestCatalogTests(unittest.TestCase):
    def test_organiser_selected_slugs_and_optional_date(self):
        for slug in (
            '2026-11-22', '2026-12-04-nelos-pro', '2026-12-nelos-pro',
            '2026-nelos-pro', 'nelos-pro', 'nelos-pro-2',
        ):
            with self.subTest(slug=slug):
                self.assertEqual(validate_entry(descriptor(slug), slug)['date'], None)
                self.assertEqual(validate_entry(descriptor(slug, date='2027-01-02'), slug)['public_slug'], slug)

    def test_descriptor_rejects_private_fields_bad_paths_and_invalid_dates(self):
        for change in (
            {'public_slug': 'different-slug'}, {'date': '2026-02-30'}, {'date': ''}, {'date': 0},
            {'phase': 'DRAFT'}, {'contest_id': 'internal-id'}, {'href': 'https://example.test/'},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_entry(descriptor('nelos-pro') | change, 'nelos-pro')
        for slug in ('NelOS-PRO', 'nelos--pro', '../nelos-pro', 'nelos%2fpro', 'a' * 65, 'con'):
            with self.subTest(slug=slug), self.assertRaises(ValueError):
                validate_entry(descriptor(slug), slug)

    def test_generator_reads_only_public_descriptors_with_matching_folder(self):
        with tempfile.TemporaryDirectory(
            prefix='meshdraw-catalog-tests-', dir=os.environ.get('MESHDRAW_TEST_TMP') or None,
        ) as temporary:
            pages = Path(temporary)
            folders = {slug: pages / 'contests' / slug for slug in ('nelos-pro', '2026-11-22')}
            for folder in folders.values():
                folder.mkdir(parents=True)
                (folder / 'index.html').write_text('<!doctype html><title>Учебный конкурс</title>', encoding='utf-8')
            archive = folders['2026-11-22']
            (archive / 'announcement.json').write_text(json.dumps({
                'title': 'Первый конкурс', 'prize': 'Учебный приз', 'ceremony_at': '2026-11-22T12:00:00Z',
            }), encoding='utf-8')
            (archive / 'show-status.json').write_text(json.dumps({
                'contest_id': 'meshcore-1000-20261122', 'phase': 'DRAWN',
            }), encoding='utf-8')
            source = folders['nelos-pro'] / 'catalog-entry.json'
            source.write_text(json.dumps(descriptor('nelos-pro')), encoding='utf-8')
            entries = catalog(pages)['contests']
            self.assertEqual([(entry['public_slug'], entry['date']) for entry in entries],
                             [('2026-11-22', '2026-11-22'), ('nelos-pro', None)])
            source.write_text(json.dumps(descriptor('nelos-pro-2')), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Invalid public catalog value'):
                catalog(pages)


if __name__ == '__main__':
    unittest.main()
