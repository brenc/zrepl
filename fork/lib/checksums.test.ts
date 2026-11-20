import { expect, test } from 'bun:test';
import { findChecksum } from './checksums.ts';

test('BSD format', () => {
  const text = 'SHA256 (a.raw.xz) = 11aa\nSHA256 (a.qcow2.xz) = 22BB\n';
  expect(findChecksum(text, 'a.qcow2.xz')).toBe('22bb');
});

test('GNU format, text and binary mode', () => {
  const text = 'aa11  debian.qcow2\nbb22 *debian.raw\n';
  expect(findChecksum(text, 'debian.qcow2')).toBe('aa11');
  expect(findChecksum(text, 'debian.raw')).toBe('bb22');
});

test('needs an exact name match', () => {
  const text = 'aa11  debian.qcow2.sig\nSHA256 (x-debian.qcow2) = bb22\n';
  expect(findChecksum(text, 'debian.qcow2')).toBeUndefined();
});
