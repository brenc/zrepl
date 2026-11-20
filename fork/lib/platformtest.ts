/** Test counts from one run of upstream's platform test harness. */
export type PlatformResult = {
  failed: number;
  passed: number;
  skipped: number;
};

/**
 * Summarize the platform test harness log.
 *
 * The harness ends with `PASSING TESTS:`, `SKIPPED TESTS:` and
 * `FAILED TESTS:` sections, each followed by indented test names; an empty
 * failed list is printed as `FAILED TESTS: []`.
 *
 * @param log Full harness output.
 * @returns Counts per section. If the summary is missing (the harness
 *   crashed before printing it), `failed` is 1 so the run never reads as
 *   clean.
 */
export function parsePlatformLog(log: string): PlatformResult {
  if (!log.includes('PASSING TESTS:'))
    return { failed: 1, passed: 0, skipped: 0 };
  const count = (section: string) => {
    const after = log.split(new RegExp(`^${section} TESTS:`, 'm'))[1];
    if (after === undefined || after.startsWith(' []')) return 0;
    const names = [];
    for (const line of after.split('\n').slice(1)) {
      if (!line.startsWith('  ')) break;
      names.push(line);
    }
    return names.length;
  };
  return {
    failed: count('FAILED'),
    passed: count('PASSING'),
    skipped: count('SKIPPED'),
  };
}
