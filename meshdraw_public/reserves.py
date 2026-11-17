"""Versioned reserve order derived from the saved RF digest and frozen tickets."""

import hashlib

from meshdraw_core.core import canonical_bytes


RESERVE_VERSION = 'meshdraw-reserve-sha256-v1'
RESERVE_PLAN_SCHEMA = 'meshdraw-pilot-plan-v2'


def validate_reserve_rule(rule, ticket_count):
    if (type(rule) is not dict or set(rule) != {'version', 'count'}
            or rule['version'] != RESERVE_VERSION or type(rule['count']) is not int
            or not 1 <= rule['count'] < ticket_count):
        raise ValueError('RESERVE_RULE_INVALID')
    return rule


def reserve_plan_sha256(base_plan_sha256, rule):
    commitment = [RESERVE_PLAN_SCHEMA, base_plan_sha256, rule]
    return hashlib.sha256(canonical_bytes(commitment)).hexdigest()


def rank_reserves(rule, tickets, calculation):
    validate_reserve_rule(rule, len(tickets))
    if calculation['status'] != 'ARCHIVE_DRAW':
        raise ValueError('RESERVE_DRAW_REQUIRED')
    winner = calculation['mapping']['ticket']
    rf_sha256 = calculation['rf']['sha256']
    candidates = []
    for index, ticket in enumerate(tickets):
        if ticket != winner:
            score = hashlib.sha256(canonical_bytes([RESERVE_VERSION, rf_sha256, ticket])).digest()
            candidates.append((score, index, ticket))
    return {'rule': rule, 'tickets': [ticket for _, _, ticket in sorted(candidates)[:rule['count']]]}
