"""Regression checks for the fail-closed per-contract release gate."""
import unittest

from check_critical_coverage import CRITICAL, evaluate


def complete_report():
    return "".join(
        f"SF:contracts/src/{name}\nLH:10\nLF:10\nBRH:9\nBRF:10\nFNH:1\nFNF:1\nend_of_record\n"
        for name in CRITICAL
    )


class CoverageGateTest(unittest.TestCase):
    def test_exact_threshold_passes(self):
        self.assertTrue(evaluate(complete_report())["passed"])

    def test_each_contract_must_meet_each_threshold(self):
        for old, new in (("BRH:9", "BRH:8"), ("LH:10", "LH:8"), ("FNH:1", "FNH:0")):
            with self.subTest(metric=old):
                self.assertFalse(evaluate(complete_report().replace(old, new, 1))["passed"])

    def test_missing_contract_and_metrics_fail(self):
        self.assertFalse(evaluate("")["passed"])
        self.assertFalse(evaluate("SF:contracts/src/BasketRouter.sol\nend_of_record")["passed"])
        self.assertFalse(evaluate(complete_report().replace("BRH:9\n", "", 1))["passed"])

    def test_impossible_counters_fail(self):
        for counter in ("BRH:-1", "BRH:11"):
            self.assertFalse(evaluate(complete_report().replace("BRH:9", counter, 1))["passed"])


if __name__ == "__main__":
    unittest.main()
