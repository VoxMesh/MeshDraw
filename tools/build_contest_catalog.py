"""Build the Pages catalog from reviewed, public contest descriptors."""

import argparse
from datetime import date
import json
from pathlib import Path
import re
import unicodedata


PAGES = Path(__file__).resolve().parents[1] / 'docs'
ARCHIVE_SLUG = '2026-11-22'
ARCHIVE_CONTEST_ID = 'meshcore-1000-20261122'
FIELDS = {'public_slug', 'title', 'prize', 'phase', 'date'}
PHASES = {'ANNOUNCED', 'OPEN', 'CLOSED', 'DRAWN', 'CANCELLED'}
SLUG = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*')
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Expected public file: {path.name}')
    return json.loads(path.read_text(encoding='utf-8'))


def ordinary_directory(path):
    return not path.is_symlink() and not path.is_junction() and path.is_dir()


def display_text(value, limit):
    return (
        isinstance(value, str) and bool(value) and value == value.strip()
        and not any(unicodedata.category(char) in ('Cc', 'Cf', 'Cs') for char in value)
        and len(value.encode('utf-16-le')) <= limit * 2
    )


def validate_slug(value):
    if value == ARCHIVE_SLUG:
        return
    if len(value) > 64 or not SLUG.fullmatch(value):
        raise ValueError(f'Invalid public slug: {value}')
    date.fromisoformat(value[:10])


def validate_entry(entry, slug):
    if not isinstance(entry, dict) or entry.keys() != FIELDS:
        raise ValueError(f'Invalid public catalog fields: {slug}')
    if (entry['public_slug'] != slug
            or not display_text(entry['title'], 150) or not display_text(entry['prize'], 160)
            or not isinstance(entry['phase'], str) or entry['phase'] not in PHASES
            or not isinstance(entry['date'], str) or not DATE.fullmatch(entry['date'])):
        raise ValueError(f'Invalid public catalog value: {slug}')
    date.fromisoformat(entry['date'])
    return entry


def first_contest(folder):
    announcement = read_json(folder / 'announcement.json')
    status = read_json(folder / 'show-status.json')
    if (status['contest_id'] != ARCHIVE_CONTEST_ID or status['phase'] != 'DRAWN'
            or not announcement['ceremony_at'].startswith(ARCHIVE_SLUG + 'T')):
        raise ValueError('Historical contest metadata does not match the archive')
    return {
        'public_slug': ARCHIVE_SLUG,
        'title': announcement['title'],
        'prize': announcement['prize'],
        'phase': status['phase'],
        'date': ARCHIVE_SLUG,
    }


def catalog(pages):
    contests = pages / 'contests'
    if not ordinary_directory(pages) or not ordinary_directory(contests):
        raise ValueError('Expected ordinary Pages and contests directories')
    entries = []
    for folder in sorted(contests.iterdir()):
        if not ordinary_directory(folder):
            raise ValueError(f'Unexpected path in contests: {folder.name}')
        validate_slug(folder.name)
        index = folder / 'index.html'
        if index.is_symlink() or not index.is_file():
            raise ValueError(f'Missing public page: {folder.name}')
        entry = first_contest(folder) if folder.name == ARCHIVE_SLUG else read_json(folder / 'catalog-entry.json')
        entries.append(validate_entry(entry, folder.name))
    if len(entries) > 500 or not any(entry['public_slug'] == ARCHIVE_SLUG for entry in entries):
        raise ValueError('Invalid catalog size or missing first contest')
    return {'schema_version': 'meshdraw-contest-catalog-v1', 'contests': entries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if the stored catalog differs')
    options = parser.parse_args()
    data = json.dumps(catalog(PAGES), ensure_ascii=False, indent=2) + '\n'
    if options.check:
        if (PAGES / 'contest-catalog.json').read_bytes() != data.encode('utf-8'):
            parser.exit(1, 'contest-catalog.json is out of date\n')
    else:
        import sys
        sys.stdout.buffer.write(data.encode('utf-8'))


if __name__ == '__main__':
    main()
