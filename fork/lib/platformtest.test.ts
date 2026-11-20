import { expect, test } from 'bun:test';
import { parsePlatformLog } from './platformtest.ts';

const t = (n: string) =>
  `  github.com/zrepl/zrepl/internal/platformtest/tests.${n}`;

test('clean run', () => {
  const log = [
    'noise',
    'PASSING TESTS:',
    t('A'),
    t('B'),
    'SKIPPED TESTS:',
    t('C'),
    'FAILED TESTS: []',
    '',
  ].join('\n');
  expect(parsePlatformLog(log)).toEqual({ failed: 0, passed: 2, skipped: 1 });
});

test('failures are listed like the other sections', () => {
  const log = [
    'PASSING TESTS:',
    t('A'),
    'SKIPPED TESTS:',
    'FAILED TESTS:',
    t('B'),
    t('C'),
  ].join('\n');
  expect(parsePlatformLog(log)).toEqual({ failed: 2, passed: 1, skipped: 0 });
});

test('missing summary counts as a failure', () => {
  expect(parsePlatformLog('panic: boom\n')).toEqual({
    failed: 1,
    passed: 0,
    skipped: 0,
  });
});
