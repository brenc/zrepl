import { describe, expect, test } from 'bun:test';
import { compareChains, parseSnapshotList, type Snapshot } from './zfs.ts';

describe('parseSnapshotList', () => {
  test('parses names and guids in order', () => {
    const out = 'tank/data@zrepl_1\t111\ntank/data@manual snap\t222\n';
    expect(parseSnapshotList(out)).toEqual([
      { guid: '111', name: 'zrepl_1' },
      { guid: '222', name: 'manual snap' },
    ]);
  });

  test('empty output means no snapshots', () => {
    expect(parseSnapshotList('')).toEqual([]);
    expect(parseSnapshotList('\n')).toEqual([]);
  });

  test('rejects lines it does not understand', () => {
    expect(() => parseSnapshotList('tank/data\t111')).toThrow();
    expect(() => parseSnapshotList('tank/data@s 111')).toThrow();
    expect(() => parseSnapshotList('tank/data@s\tabc')).toThrow();
  });
});

describe('compareChains', () => {
  const snap = (guid: string, name = `s${guid}`): Snapshot => ({ guid, name });
  const src = [snap('1'), snap('2'), snap('3')];

  test('current replica', () => {
    expect(compareChains(src, [snap('3'), snap('1')])).toEqual({
      behind: 0,
      common: true,
      latest: 's3',
    });
  });

  test('lagging replica counts snapshots after the newest common one', () => {
    expect(compareChains(src, [snap('1')])).toEqual({
      behind: 2,
      common: true,
      latest: 's3',
    });
  });

  test('matches by guid, not name', () => {
    expect(compareChains(src, [snap('3', 'renamed')])).toMatchObject({
      behind: 0,
    });
    expect(compareChains(src, [snap('9', 's3')])).toEqual({ common: false });
  });

  test('no common snapshot', () => {
    expect(compareChains(src, [])).toEqual({ common: false });
    expect(compareChains([], [snap('1')])).toEqual({ common: false });
  });
});
