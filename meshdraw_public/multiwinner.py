"""Verify a saved multiwinner contest package without network access."""

import argparse
import json
import sys

from meshdraw_core import multiwinner
from meshdraw_core.core import InputError

from .archive.math import read
from .verifier import verify_package as verify_archive


def verify_package(package, *, expected_plan_sha256=None):
    return multiwinner.verify_public_package(
        package, verify_archive=verify_archive, expected_plan_sha256=expected_plan_sha256,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", help="Path to a multiwinner verification JSON file")
    parser.add_argument("--plan-sha256", help="SHA-256 from the previously published plan")
    args = parser.parse_args()
    try:
        result = verify_package(read(args.package), expected_plan_sha256=args.plan_sha256)
    except (InputError, OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError):
        print(json.dumps({"status": "INVALID_PACKAGE"}), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
