"""Offline versioned rules for a contest with multiple prizes."""

import hashlib
import re

from .core import MAX_ROWS, TICKET_RE, canonical_bytes, to_utc_us


PLAN_SCHEMA = "meshdraw-pilot-plan-v3"
RESULT_SCHEMA = "meshdraw-pilot-result-v2"
PACKAGE_SCHEMA = "meshdraw-public-verification-v3"
ORDER_ALGORITHM = "meshdraw-reserve-sha256-v1"
POLICIES = ("AWARD_ALL", "NO_DRAW")

_PLAN_FIELDS = {
    "schema_version", "contest_id", "tickets", "winner_count", "underfilled_policy",
    "order_algorithm", "archive", "plan_sha256",
}
_ARCHIVE_FIELDS = {"mode", "profile", "start", "end", "plan_sha256"}
_SECTION_NAMES = ("plan", "result", "archive_verification")
_CONTEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", re.ASCII)
_HASH = re.compile(r"[0-9a-f]{64}", re.ASCII)
_UTC_MINUTE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z", re.ASCII)


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _fields(value, names, error):
    if type(value) is not dict or set(value) != names:
        raise ValueError(error)


def _is_hash(value):
    return type(value) is str and _HASH.fullmatch(value) is not None


def _plan_hash(plan):
    return digest({key: value for key, value in plan.items() if key != "plan_sha256"})


def outcome_for_count(ticket_count, winner_count, underfilled_policy):
    if type(ticket_count) is not int or not 0 <= ticket_count <= MAX_ROWS:
        raise ValueError("MULTIWINNER_TICKET_COUNT")
    if type(winner_count) is not int or not 1 <= winner_count <= MAX_ROWS:
        raise ValueError("MULTIWINNER_WINNER_COUNT")
    if underfilled_policy not in POLICIES:
        raise ValueError("MULTIWINNER_UNDERFILLED_POLICY")
    if ticket_count == 0 or (ticket_count < winner_count and underfilled_policy == "NO_DRAW"):
        return "NO_DRAW"
    if ticket_count == winner_count == 1 or (ticket_count <= winner_count and underfilled_policy == "AWARD_ALL"):
        return "AWARD_ALL"
    return "DRAWN"


def validate_plan(plan, *, expected_plan_sha256=None):
    _fields(plan, _PLAN_FIELDS, "MULTIWINNER_PLAN_FIELDS")
    if plan["schema_version"] != PLAN_SCHEMA or plan["order_algorithm"] != ORDER_ALGORITHM:
        raise ValueError("MULTIWINNER_PLAN_VERSION")
    contest_id = plan["contest_id"]
    if type(contest_id) is not str or _CONTEST_ID.fullmatch(contest_id) is None:
        raise ValueError("MULTIWINNER_CONTEST_ID")
    tickets = plan["tickets"]
    if type(tickets) is not list or any(
        type(ticket) is not str or TICKET_RE.fullmatch(ticket) is None for ticket in tickets
    ):
        raise ValueError("MULTIWINNER_TICKETS")
    outcome = outcome_for_count(len(tickets), plan["winner_count"], plan["underfilled_policy"])
    numbers = list(map(int, tickets))
    if any(left >= right for left, right in zip(numbers, numbers[1:])):
        raise ValueError("MULTIWINNER_TICKETS")

    archive = plan["archive"]
    if outcome == "DRAWN":
        if len(tickets) < 2:
            raise ValueError("MULTIWINNER_RF_TICKET_COUNT")
        _fields(archive, _ARCHIVE_FIELDS, "MULTIWINNER_ARCHIVE_FIELDS")
        if (archive["mode"] not in ("SYNTHETIC", "REVIEWED_PROJECTION")
                or archive["profile"] != "archive-input-v1" or not _is_hash(archive["plan_sha256"])):
            raise ValueError("MULTIWINNER_ARCHIVE_PROFILE")
        start, end = archive["start"], archive["end"]
        if any(type(value) is not str or _UTC_MINUTE.fullmatch(value) is None for value in (start, end)):
            raise ValueError("MULTIWINNER_ARCHIVE_WINDOW")
        if to_utc_us(end, "iso8601") - to_utc_us(start, "iso8601") != 60_000_000:
            raise ValueError("MULTIWINNER_ARCHIVE_WINDOW")
    elif archive is not None:
        raise ValueError("MULTIWINNER_UNEXPECTED_ARCHIVE")

    if plan["plan_sha256"] != _plan_hash(plan) or (
        expected_plan_sha256 is not None and expected_plan_sha256 != plan["plan_sha256"]
    ):
        raise ValueError("MULTIWINNER_PLAN_HASH")
    return outcome


def prepare_plan(contest_id, tickets, winner_count, underfilled_policy, *, archive=None):
    plan = {
        "schema_version": PLAN_SCHEMA, "contest_id": contest_id, "tickets": list(tickets),
        "winner_count": winner_count, "underfilled_policy": underfilled_policy,
        "order_algorithm": ORDER_ALGORITHM, "archive": None if archive is None else dict(archive),
    }
    plan["plan_sha256"] = _plan_hash(plan)
    validate_plan(plan)
    return plan


def _archive_order(plan, archive_verification, verify_archive):
    if verify_archive is None or type(archive_verification) is not dict:
        raise ValueError("MULTIWINNER_ARCHIVE_PROOF_REQUIRED")
    verified = verify_archive(archive_verification)
    calculation = verified["calculation"]
    if verified["status"] != "MATCH" or calculation["status"] != "ARCHIVE_DRAW":
        raise ValueError("MULTIWINNER_ARCHIVE_DRAW_REQUIRED")
    archive = plan["archive"]
    policy = archive_verification["policy"]
    if (archive_verification["mode"] != archive["mode"]
            or archive_verification["projection"]["original_plan_sha256"] != archive["plan_sha256"]
            or any(policy[key] != archive[key] for key in ("profile", "start", "end"))
            or policy["tickets"] != plan["tickets"]
            or (archive["mode"] == "REVIEWED_PROJECTION"
                and archive_verification["snapshot"]["schema_version"] != "meshdraw-source-snapshot-v2")):
        raise ValueError("MULTIWINNER_ARCHIVE_PLAN_MISMATCH")

    primary = calculation["mapping"]["ticket"]
    rf_hash = calculation["rf"]["sha256"]
    # This key mirrors the immutable reserve v1 rule. A collision keeps frozen order.
    remaining = sorted(
        (ticket for ticket in plan["tickets"] if ticket != primary),
        key=lambda ticket: digest([ORDER_ALGORITHM, rf_hash, ticket]),
    )
    return [primary, *remaining], rf_hash


def result_for_plan(plan, archive_verification=None, *, verify_archive=None):
    status = validate_plan(plan)
    rf_hash = None
    if status == "DRAWN":
        order, rf_hash = _archive_order(plan, archive_verification, verify_archive)
    else:
        if archive_verification is not None:
            raise ValueError("MULTIWINNER_UNEXPECTED_ARCHIVE")
        order = list(plan["tickets"]) if status == "AWARD_ALL" else []
    count = plan["winner_count"]
    return {
        "schema_version": RESULT_SCHEMA, "contest_id": plan["contest_id"],
        "plan_sha256": plan["plan_sha256"], "winner_count": count, "status": status,
        "ordered_tickets": order, "winner_tickets": order[:count], "reserve_tickets": order[count:],
        "rf_sha256": rf_hash,
    }


def build_public_package(plan, archive_verification=None, *, verify_archive=None):
    result = result_for_plan(plan, archive_verification, verify_archive=verify_archive)
    package = {
        "schema_version": PACKAGE_SCHEMA, "plan": plan, "result": result,
        "archive_verification": archive_verification,
    }
    package["manifest"] = {name: digest(package[name]) for name in _SECTION_NAMES}
    return package


def verify_public_package(package, *, verify_archive=None, expected_plan_sha256=None):
    _fields(package, {"schema_version", "manifest", *_SECTION_NAMES}, "MULTIWINNER_PACKAGE_FIELDS")
    if package["schema_version"] != PACKAGE_SCHEMA:
        raise ValueError("MULTIWINNER_PACKAGE_VERSION")
    _fields(package["manifest"], set(_SECTION_NAMES), "MULTIWINNER_MANIFEST_FIELDS")
    if any(package["manifest"][name] != digest(package[name]) for name in _SECTION_NAMES):
        raise ValueError("MULTIWINNER_MANIFEST_MISMATCH")

    plan = package["plan"]
    if expected_plan_sha256 is not None:
        validate_plan(plan, expected_plan_sha256=expected_plan_sha256)
    result = result_for_plan(plan, package["archive_verification"], verify_archive=verify_archive)
    if canonical_bytes(result) != canonical_bytes(package["result"]):
        raise ValueError("MULTIWINNER_RESULT_MISMATCH")
    provenance = "NOT_INDEPENDENTLY_CONFIRMED" if result["status"] == "DRAWN" else "NOT_APPLICABLE"
    return {"status": "MATCH", "provenance": provenance, "plan": plan, "result": result}
