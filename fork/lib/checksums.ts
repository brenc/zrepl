/**
 * Find a file's digest in a checksum list.
 *
 * Accepts both common formats: BSD (`SHA256 (file) = hex`, FreeBSD's
 * CHECKSUM.SHA256) and GNU coreutils (`hex  file` or `hex *file`, Debian's
 * SHA512SUMS).
 *
 * @param text Contents of the checksum file.
 * @param file File name exactly as listed.
 * @returns The lowercase hex digest, or undefined if `file` isn't listed.
 */
export function findChecksum(text: string, file: string): string | undefined {
  for (const line of text.split('\n')) {
    const bsd = line.match(/^[A-Z0-9]+ \((.+)\) = ([0-9a-fA-F]+)$/);
    if (bsd?.[1] === file) return bsd[2]?.toLowerCase();
    const gnu = line.match(/^([0-9a-fA-F]+) [ *](.+)$/);
    if (gnu?.[2] === file) return gnu[1]?.toLowerCase();
  }
  return undefined;
}
