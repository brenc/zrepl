/** One snapshot of a dataset, as listed by `zfs list -t snapshot`. */
export type Snapshot = { guid: string; name: string };

/**
 * Parse the output of
 * `zfs list -H -p -t snapshot -o name,guid -s createtxg -d 1 <ds>`.
 *
 * @param out Raw stdout: one `pool/ds@snap<TAB>guid` line per snapshot.
 * @returns Snapshots in the listed order (oldest first with `-s createtxg`),
 *   with `name` being the part after `@`.
 * @throws Error on a line that isn't `<dataset>@<snap><TAB><guid>`, so a
 *   change in zfs output fails loudly instead of reading as "no snapshots".
 */
export function parseSnapshotList(out: string): Snapshot[] {
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const m = line.match(/^[^@\t]+@([^\t]+)\t(\d+)$/);
      if (!m?.[1] || !m[2])
        throw new Error(`unexpected zfs list line: ${JSON.stringify(line)}`);
      return { guid: m[2], name: m[1] };
    });
}

/** How far a replica's snapshot chain trails its source's. */
export type ChainComparison =
  /** No source snapshot exists on the replica: incremental replication is impossible. */
  | { common: false }
  /**
   * @property behind Source snapshots newer than the newest one the replica
   *   has (0 when current).
   * @property latest Name of the source's newest snapshot.
   */
  | { common: true; behind: number; latest: string };

/**
 * Compare snapshot chains by GUID, which survives replication while names
 * may not.
 *
 * @param source Source snapshots, oldest first.
 * @param replica Replica snapshots, in any order.
 */
export function compareChains(
  source: Snapshot[],
  replica: Snapshot[],
): ChainComparison {
  const have = new Set(replica.map((s) => s.guid));
  const last = source.findLastIndex((s) => have.has(s.guid));
  const latest = source.at(-1);
  if (last < 0 || !latest) return { common: false };
  return {
    behind: source.length - 1 - last,
    common: true,
    latest: latest.name,
  };
}
