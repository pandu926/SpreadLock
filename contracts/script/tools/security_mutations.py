#!/usr/bin/env python3
"""Kill selected security mutations in isolated copies, never the working tree.

A compiler/tool failure is not a killed mutation. Baseline must execute and pass
all four targeted regressions before any mutation is attempted. Logs are evidence;
no secrets or network transaction signing is involved.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

MUTATIONS = (
    {'id': 'nonce', 'before': 'if (nonceUsed(intent.account, intent.epoch, intent.nonce)) revert NonceUnavailable();',
     'after': '/* SECURITY MUTATION: nonce availability guard omitted. */',
     'test': 'test_IndividualCancellation'},
    {'id': 'signature', 'before': 'if (!SignatureChecker.isValidSignatureNow(intent.account, hashIntent(intent), signature)) {',
     'after': 'if (false && !SignatureChecker.isValidSignatureNow(intent.account, hashIntent(intent), signature)) {',
     'test': 'test_WrongSignatureAndExecutorAreRejected'},
    {'id': 'final_positions', 'before': '_checkFinalPositions(intent, allPools, beforeSizes);',
     'after': '/* SECURITY MUTATION: final position checks omitted. */',
     'test': 'test_MaliciousPoolCannotOpenUnsignedMarket'},
    {'id': 'health', 'before': 'revert InsufficientPostTradeHealth();',
     'after': '/* SECURITY MUTATION: post-trade health guard omitted. */',
     'test': 'test_PostTradeEquityAndHealthGuard'},
)


def mutate(source, mutation):
    count = source.count(mutation['before'])
    if count != 1:
        raise ValueError(f"{mutation['id']}: expected one guard, found {count}")
    return source.replace(mutation['before'], mutation['after'], 1)


def killed(returncode, output):
    compiler_failure = any(marker in output for marker in ('Compiler run failed', 'Error (', 'No tests found'))
    return returncode == 1 and not compiler_failure and '[FAIL:' in output and bool(re.search(r'[1-9][0-9]* failed', output))


def run(command, cwd, logfile):
    env = dict(os.environ)
    env['FOUNDRY_PROFILE'] = 'default'
    env.pop('DREAMDEX_FORK_TESTS', None)
    result = subprocess.run(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    logfile.write_text(result.stdout)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('contracts/evidence/security-mutations'))
    options = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[3]
    contracts = root / 'contracts'
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = (contracts / 'src/BasketRouter.sol').read_text()
    report = {'schemaVersion': 1, 'startedAt': datetime.now(timezone.utc).isoformat(),
              'routerSourceSha256': hashlib.sha256(source.encode()).hexdigest(),
              'baseline': 'NOT_RUN', 'mutations': [], 'passed': False}
    try:
        with tempfile.TemporaryDirectory(prefix='spreadlock-security-mutations-') as tmp:
            work = pathlib.Path(tmp)
            shutil.copytree(contracts, work / 'contracts', ignore=shutil.ignore_patterns('out', 'cache', 'evidence', 'broadcast', '__pycache__'))
            (work / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
            router = work / 'contracts/src/BasketRouter.sol'
            base = ['forge', 'test', '--root', str(work / 'contracts'), '-vv', '--match-test']
            baseline = run(base + ['|'.join(m['test'] for m in MUTATIONS)], work, output / 'baseline.log')
            if baseline.returncode != 0 or not re.search(r'4 tests passed, 0 failed', baseline.stdout):
                report['baseline'] = 'FAIL'
                raise RuntimeError('Mutation baseline did not execute and pass all four target tests')
            report['baseline'] = 'PASS'
            for mutation in MUTATIONS:
                router.write_text(mutate(source, mutation))
                result = run(base + [mutation['test']], work, output / f"{mutation['id']}.log")
                hit = killed(result.returncode, result.stdout)
                report['mutations'].append({'id': mutation['id'], 'test': mutation['test'],
                                            'status': 'KILLED' if hit else 'SURVIVED_OR_INVALID',
                                            'exitCode': result.returncode, 'log': f"{mutation['id']}.log"})
                router.write_text(source)
            report['passed'] = all(m['status'] == 'KILLED' for m in report['mutations']) and len(report['mutations']) == len(MUTATIONS)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        report['error'] = str(error)
    report['completedAt'] = datetime.now(timezone.utc).isoformat()
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
