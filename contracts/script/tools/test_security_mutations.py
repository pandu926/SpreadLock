import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).with_name('security_mutations.py')


class MutationDefinitionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('security_mutations', MODULE)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_exactly_four_named_security_guards(self):
        self.assertEqual({m['id'] for m in self.module.MUTATIONS}, {'nonce', 'signature', 'final_positions', 'health'})

    def test_every_mutation_changes_exactly_one_live_guard(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        source = (root / 'src/BasketRouter.sol').read_text()
        for mutation in self.module.MUTATIONS:
            with self.subTest(mutation=mutation['id']):
                changed = self.module.mutate(source, mutation)
                self.assertNotEqual(changed, source)
                self.assertEqual(source.count(mutation['before']), 1)
                self.assertIn(mutation['after'], changed)

    def test_missing_or_ambiguous_guard_fails_closed(self):
        mutation = self.module.MUTATIONS[0]
        with self.assertRaises(ValueError):
            self.module.mutate('different source', mutation)
        with self.assertRaises(ValueError):
            self.module.mutate(mutation['before'] * 2, mutation)

    def test_compile_failure_is_not_a_killed_mutation(self):
        self.assertFalse(self.module.killed(1, 'Compiler run failed! expected revert'))
        self.assertFalse(self.module.killed(1, 'unknown tool failure'))
        self.assertFalse(self.module.killed(0, '1 passed; 0 failed'))
        self.assertFalse(self.module.killed(-9, '[FAIL: expected revert] test_A()\nSuite result: FAILED. 0 passed; 1 failed'))
        self.assertFalse(self.module.killed(2, '[FAIL: expected revert] test_A()\nSuite result: FAILED. 0 passed; 1 failed'))
        self.assertTrue(self.module.killed(1, '[FAIL: next call did not revert as expected] test_A()\nSuite result: FAILED. 0 passed; 1 failed; 0 skipped'))


if __name__ == '__main__':
    unittest.main()
