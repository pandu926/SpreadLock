#!/usr/bin/env python3
"""Fail unless every production SpreadLock contract meets the LCOV release gate.

Run from the repository root after:
  forge coverage --ir-minimum --exclude-tests --report lcov \
    --report-file contracts/evidence/hardening.lcov
"""
import argparse
import json
from pathlib import Path

CRITICAL = (
    "BasketAccount.sol",
    "BasketAccountFactory.sol",
    "BasketRouter.sol",
    "MarketRegistry.sol",
    "SpreadLockGovernor.sol",
)
THRESHOLDS = {"lines": 90, "branches": 90, "functions": 100}
FIELDS = {"lines": ("LH", "LF"), "branches": ("BRH", "BRF"), "functions": ("FNH", "FNF")}


def evaluate(lcov: str) -> dict:
    records = {}
    for block in lcov.split("end_of_record"):
        fields = dict(line.split(":", 1) for line in block.splitlines() if ":" in line and not line.startswith(("DA:", "BRDA:", "FN:", "FNDA:")))
        source = fields.get("SF", "")
        for name in CRITICAL:
            if source.endswith("/src/" + name):
                records[name] = fields
    contracts = {}
    for name in CRITICAL:
        fields = records.get(name)
        metrics = {}
        for metric, (hit_key, total_key) in FIELDS.items():
            hit, total = (int(fields.get(hit_key, 0)), int(fields.get(total_key, 0))) if fields else (0, 0)
            # Zero-branch contracts can pass a branch gate, but missing files cannot.
            percent = hit * 100 / total if total else (100 if fields else 0)
            complete = fields is not None and hit_key in fields and total_key in fields
            valid = 0 <= hit <= total and (total > 0 or metric == "branches")
            passed = complete and valid and hit * 100 >= THRESHOLDS[metric] * total
            metrics[metric] = {"hit": hit, "total": total, "percent": round(percent, 2), "minimum": THRESHOLDS[metric], "passed": passed}
        contracts[name] = {"present": fields is not None, "metrics": metrics, "passed": all(m["passed"] for m in metrics.values())}
    return {"passed": all(c["passed"] for c in contracts.values()), "contracts": contracts}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lcov", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = evaluate(args.lcov.read_text())
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
