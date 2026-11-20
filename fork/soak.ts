#!/usr/bin/env bun
/**
 * Real-ZFS tests of zrepl in disposable VMs (see fork/vm.ts), run without
 * root on the host.
 *
 *   bun fork/soak.ts platform <os>
 *     Run upstream's platform test suite in a fresh VM.
 *
 *   bun fork/soak.ts topo up | churn | verify | logs | down
 *   bun fork/soak.ts topo soak [minutes]
 *     A three-VM copy of the production topology:
 *       src  FreeBSD  like store03:  snap job + TLS source
 *       mid  Debian   like backup01: TLS pull from src, TCP source
 *       off  Debian   like rbackup02: TCP pull from mid
 *     Intervals and retention grids are scaled from hours and days down to
 *     minutes so a soak of an hour or two covers many prune cycles. `soak`
 *     churns data, verifies every few minutes and exits non-zero on any
 *     failure or logged error.
 *
 * Builds come from `make zrepl-bin` / `make test-platform-bin` (run them
 * for linux and freebsd first; `soak.ts` checks they exist).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = dirname(import.meta.dir);
const VM = join(REPO, "fork", "vm.ts");
const WORK = join(process.env.ZRVM_RUN ?? `/var/tmp/zrepl-vm-${process.getuid?.()}`, "_soak");
const POOL = "tank";

type OS = "debian" | "freebsd";
const goos = (os: OS) => (os === "debian" ? "linux" : "freebsd");
const artifact = (kind: "zrepl" | "platformtest", os: OS) =>
  join(REPO, "artifacts", `${kind}-${goos(os)}-amd64`);

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function vm(args: string[], allowFail = false) {
  const p = Bun.spawnSync(["bun", VM, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString();
  const err = p.stderr.toString();
  if (p.exitCode !== 0 && !allowFail) die(`vm ${args.slice(0, 2).join(" ")}: ${err.trim() || out.trim()}`);
  return { ok: p.exitCode === 0, out, err };
}

const sh = (name: string, cmd: string, allowFail = false) => vm(["ssh", name, cmd], allowFail);
const put = (name: string, src: string, dst: string) => vm(["put", name, src, dst]);

function needArtifact(kind: "zrepl" | "platformtest", os: OS) {
  const a = artifact(kind, os);
  if (!existsSync(a)) {
    const target = kind === "zrepl" ? "zrepl-bin" : "test-platform-bin";
    die(`missing ${a}; run: make ${target} GOOS=${goos(os)} GOARCH=amd64`);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Platform tests

async function platform(os: OS) {
  const bin = needArtifact("platformtest", os);
  const name = `pt-${os}`;
  vm(["down", name], true);
  console.log(`${name}: starting`);
  vm(["up", name, os]);
  try {
    put(name, bin, "/root/platformtest");
    console.log(`${name}: running platform tests`);
    const r = sh(name, "cd /root && ./platformtest -poolname zreplplatformtest " +
      "-imagepath /tmp/zreplplatformtest.pool.img -mountpoint /tmp/zreplplatformtest.pool " +
      "> pt.log 2>&1; echo exit=$?", true);
    mkdirSync(WORK, { recursive: true });
    const log = join(WORK, `platform-${os}.log`);
    vm(["get", name, "/root/pt.log", log]);
    const text = await Bun.file(log).text();
    const count = (section: string) => {
      const m = text.split(`${section} TESTS:`)[1] ?? "";
      return m.split("\n").slice(1).filter((l) => l.startsWith("  github.com")).length;
    };
    // "FAILED TESTS: []" when none, otherwise a list like the other sections
    const failed = /FAILED TESTS: \[\]/.test(text) ? 0 : count("FAILED");
    const zfsv = sh(name, "zfs version | head -1").out.trim();
    console.log(`${name}: ${zfsv}: ${count("PASSING")} passed, ${count("SKIPPED")} skipped, ${failed} failed`);
    console.log(`${name}: log ${log}`);
    if (!r.out.includes("exit=0") || failed !== 0) process.exitCode = 1;
  } finally {
    vm(["down", name], true);
  }
}

// ---------------------------------------------------------------------------
// Production-shaped topology

/** `serves` is the guest port the host's zrepl listens on, if any. */
type Host = { name: string; os: OS; serves?: number };
const SRC: Host = { name: "src", os: "freebsd", serves: 8000 };
const MID: Host = { name: "mid", os: "debian", serves: 8001 };
const OFF: Host = { name: "off", os: "debian" };
const HOSTS = [SRC, MID, OFF];

/**
 * VMs reach each other through ports forwarded on the host (see vm.ts), so
 * a peer's address is 10.0.2.2:<host port> and every peer connects from
 * 10.0.2.2.
 */
const QEMU_HOST = "10.0.2.2";
const addrOf = (h: Host) => `${QEMU_HOST}:${vm(["port", h.name, String(h.serves)]).out.trim()}`;
const etc = (h: Host) => (h.os === "freebsd" ? "/usr/local/etc/zrepl" : "/etc/zrepl");

/** Source datasets on src and what should happen to each. */
const DATASETS: { rel: string; expect: "replicated" | "excluded" }[] = [
  { rel: "data", expect: "replicated" },
  { rel: "data/a", expect: "replicated" },
  { rel: "data/a/b", expect: "replicated" },
  { rel: "data/big", expect: "replicated" },
  { rel: "data/upload_tmp", expect: "excluded" },
  { rel: "data/upload_tmp/x", expect: "excluded" },
];

/** Received paths: a pull job puts a source fs at root_fs/<source path>. */
const onMid = (rel: string) => `${POOL}/zrepl/${POOL}/${rel}`;
const onOff = (rel: string) => `${POOL}/zrepl/${onMid(rel)}`;

/**
 * Receive-side overrides from the H1 mitigation: received datasets must
 * never mount, whatever the sender's stream says.
 */
const RECV = `    recv:
      placeholder:
        encryption: inherit
      properties:
        override: {
          readonly: "on",
          mountpoint: "none",
          canmount: "off",
        }
`;

const LOGGING = `  logging:
    - type: stdout
      level: info
      format: human
`;

function srcConfig() {
  return `global:
${LOGGING}
jobs:
  - name: snapshots
    type: snap
    filesystems: {
      "${POOL}/data<": true,
      "${POOL}/data/upload_tmp<": false,
    }
    snapshotting:
      type: periodic
      prefix: zrepl_
      interval: 1m
    pruning:
      keep:
        - type: regex
          negate: true
          regex: ^zrepl_
        # production: 1x1h(keep=all) | 24x1h | 30x1d | 3x30d
        - type: grid
          grid: 1x5m(keep=all) | 6x5m | 4x15m
          regex: ^zrepl_

  - name: source
    type: source
    serve:
      type: tls
      listen: ":${SRC.serves}"
      ca: ${etc(SRC)}/ssl/mid.crt
      client_cns:
        - mid
      cert: ${etc(SRC)}/ssl/src.crt
      key: ${etc(SRC)}/ssl/src.key
    filesystems: {
      "${POOL}/data<": true,
      "${POOL}/data/upload_tmp<": false,
    }
    snapshotting:
      type: manual
`;
}

function midConfig() {
  return `global:
${LOGGING}
jobs:
  - name: pull_from_src
    type: pull
${RECV}
    conflict_resolution:
      initial_replication: all
    connect:
      type: tls
      address: "${addrOf(SRC)}"
      ca: ${etc(MID)}/ssl/src.crt
      server_cn: src
      cert: ${etc(MID)}/ssl/mid.crt
      key: ${etc(MID)}/ssl/mid.key
    root_fs: ${POOL}/zrepl
    interval: 1m
    pruning:
      keep_sender:
        - type: regex
          regex: .*
      keep_receiver:
        - type: regex
          negate: true
          regex: ^zrepl_
        # production: 1x1h(keep=all) | 24x1h | 30x1d | 6x30d
        - type: grid
          grid: 1x5m(keep=all) | 6x5m | 6x15m
          regex: ^zrepl_
    replication:
      concurrency:
        steps: 1

  - name: source_offsite
    type: source
    filesystems: {
      "${onMid("data")}<": true,
    }
    serve:
      type: tcp
      listen: ":${MID.serves}"
      clients: {
        "${QEMU_HOST}": "off",
      }
    snapshotting:
      type: manual
`;
}

function offConfig() {
  return `global:
${LOGGING}
jobs:
  - name: pull_offsite
    type: pull
    interval: 1m
    conflict_resolution:
      initial_replication: all
    connect:
      type: tcp
      address: "${addrOf(MID)}"
    root_fs: ${POOL}/zrepl
${RECV}
    pruning:
      keep_sender:
        - type: regex
          regex: .*
      keep_receiver:
        - type: regex
          negate: true
          regex: ^zrepl_
        # production: 1x1h(keep=all) | 24x1h | 30x1d | 9x30d
        - type: grid
          grid: 1x5m(keep=all) | 6x5m | 8x15m
          regex: ^zrepl_
    replication:
      concurrency:
        steps: 2
`;
}

/** Self-signed cert per host, pinned by its peer, as gen_zrepl_cert.sh does. */
function makeCert(dir: string, cn: string) {
  const p = Bun.spawnSync(["openssl", "req", "-x509", "-sha256", "-nodes", "-newkey", "rsa:2048",
    "-days", "30", "-keyout", join(dir, `${cn}.key`), "-out", join(dir, `${cn}.crt`),
    "-addext", `subjectAltName = DNS:${cn}`, "-subj", `/CN=${cn}`], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) die(`openssl: ${p.stderr.toString()}`);
}

function startDaemon(h: Host) {
  const cfg = `${etc(h)}/zrepl.yml`;
  const cmd = h.os === "freebsd"
    ? `daemon -f -o /var/log/zrepl.log -p /var/run/zrepl-daemon.pid /usr/local/bin/zrepl --config ${cfg} daemon`
    : `systemd-run --unit=zrepl --property=StandardOutput=append:/var/log/zrepl.log --property=StandardError=append:/var/log/zrepl.log /usr/local/bin/zrepl --config ${cfg} daemon`;
  sh(h.name, `mkdir -p /var/run/zrepl/stdinserver && chmod -R 0700 /var/run/zrepl && ${cmd}`);
}

async function topoUp() {
  for (const h of HOSTS) needArtifact("zrepl", h.os);
  rmSync(WORK, { recursive: true, force: true });
  const ssl = join(WORK, "ssl");
  mkdirSync(ssl, { recursive: true, mode: 0o700 });
  makeCert(ssl, "src");
  makeCert(ssl, "mid");
  for (const h of HOSTS) {
    console.log(`${h.name}: starting ${h.os}`);
    vm(["up", h.name, h.os, ...(h.serves ? [String(h.serves)] : [])]);
  }
  // Configs name peers by forwarded host port, known only once all are up.
  const configs: Record<string, string> = { src: srcConfig(), mid: midConfig(), off: offConfig() };

  for (const h of HOSTS) {
    put(h.name, artifact("zrepl", h.os), "/usr/local/bin/zrepl");
    sh(h.name, `chmod 755 /usr/local/bin/zrepl && mkdir -p ${etc(h)}/ssl && chmod 700 ${etc(h)}/ssl`);
    for (const f of ["src.crt", "mid.crt", `${h.name}.key`])
      if (existsSync(join(ssl, f)) && (f.endsWith(".crt") || h.name !== "off")) put(h.name, join(ssl, f), `${etc(h)}/ssl/${f}`);
    const cfg = join(WORK, `${h.name}.yml`);
    writeFileSync(cfg, configs[h.name]!);
    put(h.name, cfg, `${etc(h)}/zrepl.yml`);
    sh(h.name, `chmod 600 ${etc(h)}/zrepl.yml ${etc(h)}/ssl/*`);
    sh(h.name, `truncate -s 4G /var/tmp/${POOL}.img && zpool create -o cachefile=none ` +
      `-O compression=lz4 -O mountpoint=/${POOL} ${POOL} /var/tmp/${POOL}.img`);
    if (h !== SRC) sh(h.name, `zfs create ${POOL}/zrepl`);
    sh(h.name, `/usr/local/bin/zrepl --config ${etc(h)}/zrepl.yml configcheck`);
  }
  for (const d of DATASETS) sh(SRC.name, `zfs create ${POOL}/${d.rel}`);
  churn();
  for (const h of HOSTS) startDaemon(h);
  console.log("topology up; first replication within about 2 minutes");
}

function churn() {
  const cmds = DATASETS.map((d) => {
    const size = d.rel === "data/big" ? 64 : 1;
    return `dd if=/dev/urandom of=/${POOL}/${d.rel}/f-$(date +%s)-$$ bs=1m count=${size} 2>/dev/null`;
  });
  sh(SRC.name, cmds.join(" && "));
}

/** guid -> snapshot name for every snapshot of `ds`, oldest first. */
function snaps(h: Host, ds: string): [string, string][] {
  const r = sh(h.name, `zfs list -H -p -t snapshot -o name,guid -s createtxg -d 1 ${ds} 2>/dev/null`, true);
  return r.out.trim().split("\n").filter(Boolean).map((l) => {
    const [name, guid] = l.split("\t");
    return [guid!, name!.split("@")[1]!];
  });
}

function exists(h: Host, ds: string) {
  return sh(h.name, `zfs list -H -o name ${ds}`, true).ok;
}

type Verdict = { fail: number; lag: number; lines: string[] };

/** Allowed lag in snapshots before it counts as a failure. */
const MAX_LAG = 3;

function compareHop(from: Host, fromDs: string, to: Host, toDs: string, v: Verdict) {
  const label = `${from.name}->${to.name} ${fromDs}`;
  if (!exists(to, toDs)) { v.fail++; v.lines.push(`FAIL  missing on ${to.name}          ${label}`); return; }
  const a = snaps(from, fromDs);
  const b = new Set(snaps(to, toDs).map(([g]) => g));
  const last = a.findLastIndex(([g]) => b.has(g));
  const behind = a.length - 1 - last;
  if (last < 0) { v.fail++; v.lines.push(`FAIL  no common snapshot          ${label}`); return; }
  if (behind > MAX_LAG) { v.fail++; v.lines.push(`FAIL  ${behind} snapshots behind       ${label}`); return; }
  if (behind > 0) v.lag++;
  v.lines.push(`ok    ${behind ? `${behind} behind` : "current"}`.padEnd(32) + label);

  const props = sh(to.name, `zfs get -H -o value mounted,canmount,mountpoint,readonly ${toDs}`).out.trim().split("\n");
  const [mounted, canmount, mountpoint, readonly] = props;
  if (mounted !== "no" || canmount !== "off" || mountpoint !== "none" || readonly !== "on") {
    v.fail++;
    v.lines.push(`FAIL  props mounted=${mounted} canmount=${canmount} mountpoint=${mountpoint} readonly=${readonly} on ${to.name} ${toDs}`);
  }
}

function verify(): Verdict {
  const v: Verdict = { fail: 0, lag: 0, lines: [] };
  for (const d of DATASETS) {
    const src = `${POOL}/${d.rel}`;
    if (d.expect === "excluded") {
      for (const [h, ds] of [[MID, onMid(d.rel)], [OFF, onOff(d.rel)]] as const) {
        if (exists(h, ds)) { v.fail++; v.lines.push(`FAIL  excluded but on ${h.name}       ${src}`); }
      }
      v.lines.push(`ok    excluded`.padEnd(32) + src);
      continue;
    }
    compareHop(SRC, src, MID, onMid(d.rel), v);
    compareHop(MID, onMid(d.rel), OFF, onOff(d.rel), v);
  }
  for (const h of HOSTS) {
    const errs = sh(h.name, "grep -c '\\[ERRO\\]' /var/log/zrepl.log || true").out.trim();
    if (errs !== "0") { v.fail++; v.lines.push(`FAIL  ${errs} logged errors on ${h.name}`); }
    if (!sh(h.name, h.os === "freebsd" ? "pgrep -f 'zrepl --config'" : "systemctl is-active zrepl", true).ok) {
      v.fail++; v.lines.push(`FAIL  zrepl daemon not running on ${h.name}`);
    }
    const count = sh(h.name, `zfs list -H -t snapshot -o name -r ${POOL} | wc -l`).out.trim();
    v.lines.push(`info  ${h.name} holds ${count} snapshots`);
  }
  return v;
}

function printVerdict(v: Verdict) {
  for (const l of v.lines) console.log(l);
  console.log(v.fail ? `RESULT: ${v.fail} failure(s)` : "RESULT: ok");
}

async function soak(minutes: number) {
  const end = Date.now() + minutes * 60_000;
  let rounds = 0;
  let worst = 0;
  // Let the first full replication through both hops finish.
  await Bun.sleep(4 * 60_000);
  while (Date.now() < end) {
    churn();
    await Bun.sleep(3 * 60_000);
    const v = verify();
    rounds++;
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`[${stamp}] round ${rounds}: ${v.fail ? `${v.fail} failure(s)` : "ok"}, ${v.lag} lagging`);
    if (v.fail) { printVerdict(v); worst = Math.max(worst, v.fail); }
  }
  const final = verify();
  printVerdict(final);
  if (worst || final.fail) process.exit(1);
}

function logs(name: string) {
  console.log(sh(name, "tail -n 60 /var/log/zrepl.log").out);
}

function topoDown() {
  for (const h of HOSTS) vm(["down", h.name], true);
  console.log("topology down");
}

const [cmd, sub, arg] = process.argv.slice(2);
switch (cmd) {
  case "platform": await platform(sub === "freebsd" ? "freebsd" : sub === "debian" ? "debian" : die("os: debian|freebsd")); break;
  case "topo":
    switch (sub) {
      case "up": await topoUp(); break;
      case "churn": churn(); break;
      case "verify": { const v = verify(); printVerdict(v); if (v.fail) process.exit(1); break; }
      case "soak": await soak(Number(arg ?? 60)); break;
      case "logs": logs(arg ?? die("which host: src|mid|off")); break;
      case "down": topoDown(); break;
      default: die("topo {up|churn|verify|soak [minutes]|logs <host>|down}");
    }
    break;
  default:
    console.error("usage: bun fork/soak.ts {platform <os>|topo ...}");
    process.exit(2);
}
