"""Versioned multiwinner contract checks using only synthetic evidence."""

from pathlib import Path
import unittest

from meshdraw_core import multiwinner
from meshdraw_public.archive import math as archive_math
from meshdraw_public.multiwinner import verify_package
from meshdraw_public.reserves import RESERVE_VERSION, rank_reserves
from meshdraw_public.verifier import _input, verify_package as verify_archive


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "synthetic"
VECTORS = archive_math.read(FIXTURES / "multiwinner-vectors.json")


def create_package(vector):
    tickets = [f"{i:04}" for i in range(1, vector["size"] + 1)]
    archive = None
    evidence = None
    if vector["status"] == "DRAWN":
        evidence = archive_math.read(FIXTURES / "verification.json")
        policy = evidence["policy"]
        policy["tickets"] = tickets
        source_input, selected = _input(policy, evidence["snapshot"])
        policy["input_document_sha256_before_calculation"] = multiwinner.digest(source_input)
        calculation = archive_math.evaluate(policy, source_input)
        evidence["expected"] = {"selection": selected, "calculation": calculation}
        for key in ("policy", "expected"):
            evidence["manifest"][key] = multiwinner.digest(evidence[key])
        archive = {key: policy[key] for key in ("profile", "start", "end")}
        archive["mode"] = evidence["mode"]
        archive["plan_sha256"] = evidence["projection"]["original_plan_sha256"]
    plan = multiwinner.prepare_plan("synthetic-multiwinner", tickets, 10, vector["policy"], archive=archive)
    return multiwinner.build_public_package(plan, evidence, verify_archive=verify_archive)


class MultiwinnerTests(unittest.TestCase):
    def test_single_ticket_uses_no_radio_when_there_is_one_prize(self):
        plan = multiwinner.prepare_plan("single", ["0001"], 1, "NO_DRAW")
        package = multiwinner.build_public_package(plan)
        self.assertEqual(verify_package(package)["result"]["winner_tickets"], ["0001"])
        self.assertEqual(package["result"]["status"], "AWARD_ALL")
        self.assertIsNone(package["archive_verification"])

    def test_common_order_vectors(self):
        for vector in VECTORS:
            with self.subTest(vector=vector["name"]):
                package = create_package(vector)
                verified = verify_package(package, expected_plan_sha256=package["plan"]["plan_sha256"])
                result = verified["result"]
                self.assertEqual(verified["status"], "MATCH")
                self.assertEqual(result["status"], vector["status"])
                self.assertEqual(result["ordered_tickets"], vector["order"])
                self.assertEqual(result["winner_tickets"], vector["order"][:10])
                self.assertEqual(result["reserve_tickets"], vector["order"][10:])
                if vector["status"] == "DRAWN":
                    tickets = verified["plan"]["tickets"]
                    calculation = package["archive_verification"]["expected"]["calculation"]
                    reserve_rule = {"version": RESERVE_VERSION, "count": len(tickets) - 1}
                    old_order = rank_reserves(reserve_rule, tickets, calculation)["tickets"]
                    self.assertEqual(result["ordered_tickets"], [calculation["mapping"]["ticket"], *old_order])
                else:
                    self.assertIsNone(result["rf_sha256"])
                    self.assertIsNone(package["archive_verification"])

    def test_rehashed_changes_to_tail_or_winner_boundary_are_rejected(self):
        for left, right in ((11, 12), (9, 10), (12, 0)):
            with self.subTest(positions=(left, right)):
                package = create_package(VECTORS[-1])
                order = package["result"]["ordered_tickets"]
                order[left], order[right] = order[right], order[left]
                package["result"].update(winner_tickets=order[:10], reserve_tickets=order[10:])
                package["manifest"]["result"] = multiwinner.digest(package["result"])
                with self.assertRaisesRegex(ValueError, "MULTIWINNER_RESULT_MISMATCH"):
                    verify_package(package)

    def test_rehashed_plan_from_a_different_contest_fails_external_pin(self):
        package = create_package(VECTORS[-1])
        plan = package["plan"]
        changed = multiwinner.prepare_plan("different-contest", plan["tickets"], 10,
                                          plan["underfilled_policy"], archive=plan["archive"])
        replaced = multiwinner.build_public_package(changed, package["archive_verification"],
                                                   verify_archive=verify_archive)
        with self.assertRaisesRegex(ValueError, "MULTIWINNER_PLAN_HASH"):
            verify_package(replaced, expected_plan_sha256=plan["plan_sha256"])

    def test_refuses_other_archive_window_and_unexpected_rf(self):
        package = create_package(VECTORS[-1])
        plan = package["plan"]
        archive = dict(plan["archive"], start="2030-01-01T01:04:00Z", end="2030-01-01T01:05:00Z")
        changed = multiwinner.prepare_plan(plan["contest_id"], plan["tickets"], 10, "AWARD_ALL", archive=archive)
        with self.assertRaisesRegex(ValueError, "MULTIWINNER_ARCHIVE_PLAN_MISMATCH"):
            multiwinner.build_public_package(changed, package["archive_verification"], verify_archive=verify_archive)
        award_plan = create_package(VECTORS[1])["plan"]
        with self.assertRaisesRegex(ValueError, "MULTIWINNER_UNEXPECTED_ARCHIVE"):
            multiwinner.build_public_package(award_plan, package["archive_verification"], verify_archive=verify_archive)

    def test_ticket_numbers_cannot_have_duplicate_numeric_values(self):
        with self.assertRaisesRegex(ValueError, "MULTIWINNER_TICKETS"):
            multiwinner.prepare_plan("duplicate-number", ["0001", "001"], 10, "AWARD_ALL")
