#!/usr/bin/env bun
/**
 * Throwaway ZFS test bed for zrepl on Linux and FreeBSD.
 *
 * Builds two file-backed pools (a source and a destination), a dataset tree
 * that exercises subtree filters, an exclude rule and raw encrypted send,
 * plus a zrepl config with a push job replicating over TCP on localhost into
 * a sink job in the same daemon. Everything lives under one work directory
 * and is removed by `down`.
 *
 * This complements upstream's platform tests (`sudo make test-platform`),
 * which exercise ZFS operations one at a time: this runs the whole daemon,
 * snapshotting, replication and pruning together, for soak testing.
 *
 * Usage (pool commands need root):
 *   sudo bun fork/testpool.ts up          create pools, data and config
 *   bun fork/testpool.ts up --config-only write and check the config only
 *   sudo bun fork/testpool.ts daemon      run zrepl in the foreground
 *   sudo bun fork/testpool.ts status      zrepl status (TUI; JSON without a
 *                                         terminal)
 *   sudo bun fork/testpool.ts wakeup      replicate now instead of waiting
 *   sudo bun fork/testpool.ts churn       write new data into every dataset
 *   sudo bun fork/testpool.ts verify      check replication against intent
 *   sudo bun fork/testpool.ts down        stop daemon, destroy pools, clean
 *
 * If sudo can't find bun, use `sudo "$(command -v bun)" ...`.
 *
 * Environment:
 *   ZRTEST_DIR   work directory (default /var/tmp/zrepl-test)
 *   ZRTEST_PORT  replication port; metrics use port+1 (default 18888)
 *   ZREPL        zrepl binary (default: this repo's `make zrepl-bin` output
 *                for the host, then zrepl on PATH)
 *
 * Safety: `up` refuses to run if a pool with either test name exists, pools
 * are created with cachefile=none so they never import at boot, and `down`
 * destroys a pool only if all its vdevs are image files in the work dir.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const WORKDIR = process.env.ZRTEST_DIR ?? "/var/tmp/zrepl-test";
const PORT = Number(process.env.ZRTEST_PORT ?? 18888);
const SRC = "zrtest_src";
const DST = "zrtest_dst";
const POOL_SIZE = 1 << 30; // sparse, so only written blocks use disk
const CLIENT = "testclient";
const PUSH_JOB = "push";
const PUSH_ENC_JOB = "push_enc";
const SINK_JOB = "sink";

/**
 * Dataset tree under the source pool and what replication should do with
 * each. `verify` checks the destination against `expect`, so a dataset
 * that zrepl silently skips, or wrongly sends, shows up as a failure.
 */
const DATASETS: { rel: string; expect: "replicated" | "excluded"; encrypted?: boolean }[] = [
  { rel: "data", expect: "replicated" },
  { rel: "data/a", expect: "replicated" },
  { rel: "data/a/b", expect: "replicated" },
  { rel: "data/enc", expect: "replicated", encrypted: true },
  { rel: "data/skip", expect: "excluded" },
  { rel: "data/skip/child", expect: "excluded" },
];

const paths = {
  config: join(WORKDIR, "zrepl.yml"),
  encKey: join(WORKDIR, "enc.key"),
  control: join(WORKDIR, "control"),
  stdinserver: join(WORKDIR, "stdinserver"),
  pid: join(WORKDIR, "daemon.pid"),
  log: join(WORKDIR, "zrepl.log"),
  img: (pool: string) => join(WORKDIR, `${pool}.img`),
  mnt: (pool: string) => join(WORKDIR, "mnt", pool),
};

/** Where `zfs recv` puts a source dataset: root_fs/<client identity>/<src>. */
const destOf = (rel: string) => `${DST}/sink/${CLIENT}/${SRC}/${rel}`;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Run argv without a shell; throws with stderr unless `allowFail`. */
function run(argv: string[], allowFail = false): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const res = { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
  if (!res.ok && !allowFail) die(`${argv.join(" ")}\n${res.err.trim()}`);
  return res;
}

async function runInteractive(argv: string[]): Promise<number> {
  const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}

function requireRoot() {
  if (process.getuid?.() !== 0) die("this command needs root (sudo)");
}

function zreplBin(): string {
  if (process.env.ZREPL) return process.env.ZREPL;
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  const repo = dirname(import.meta.dir);
  const built = join(repo, "artifacts", `zrepl-${process.platform}-${arch}`);
  if (arch && existsSync(built)) return built;
  return Bun.which("zrepl") ?? die("no zrepl binary: run make zrepl-bin or set ZREPL");
}

function poolExists(pool: string): boolean {
  return run(["zpool", "list", "-H", "-o", "name", pool], true).ok;
}

function zrepl(...args: string[]): string[] {
  return [zreplBin(), "--config", paths.config, ...args];
}

function renderConfig(): string {
  return `# Generated by fork/testpool.ts. Throwaway test config.
global:
  logging:
    - type: "stdout"
      level: "info"
      format: "human"
  control:
    sockpath: "${paths.control}"
  serve:
    stdinserver:
      sockdir: "${paths.stdinserver}"
  monitoring:
    - type: "prometheus"
      listen: "127.0.0.1:${PORT + 1}"

jobs:
  - name: "${SINK_JOB}"
    type: "sink"
    root_fs: "${DST}/sink"
    serve:
      type: "tcp"
      listen: "127.0.0.1:${PORT}"
      clients: {
        "127.0.0.1": "${CLIENT}",
      }
    recv:
      placeholder:
        # The receiver never has the key for raw encrypted sends, so
        # placeholders above them must be unencrypted.
        encryption: "off"

  # zrepl refuses to mix encrypted and unencrypted datasets in one job's
  # send policy, so each kind gets its own push job.
  - name: "${PUSH_JOB}"
    type: "push"
    connect: ${CONNECT}
    filesystems: {
      "${SRC}/data<": true,
      "${SRC}/data/skip<": false,
      "${SRC}/data/enc<": false,
    }
${COMMON}
  - name: "${PUSH_ENC_JOB}"
    type: "push"
    connect: ${CONNECT}
    filesystems: {
      "${SRC}/data/enc<": true,
    }
    send:
      encrypted: true
${COMMON}`;
}

/** Inline YAML for the push jobs' connect section. */
const CONNECT = `{ type: "tcp", address: "127.0.0.1:${PORT}" }`;

/** Snapshotting and pruning shared by both push jobs. */
const COMMON = `    snapshotting:
      type: "periodic"
      interval: "1m"
      prefix: "zrepl_"
    pruning:
      keep_sender:
        - type: "not_replicated"
        - type: "last_n"
          count: 5
          regex: "^zrepl_"
        # keep anything not made by zrepl, e.g. manual snapshots
        - type: "regex"
          negate: true
          regex: "^zrepl_"
      keep_receiver:
        - type: "last_n"
          count: 10
          regex: "^zrepl_"
        - type: "regex"
          negate: true
          regex: "^zrepl_"
`;

function writeConfig() {
  mkdirSync(WORKDIR, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stdinserver, { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, renderConfig(), { mode: 0o600 });
  const check = run(zrepl("configcheck"), true);
  if (!check.ok) die(`configcheck failed:\n${check.err || check.out}`);
  console.log(`config: ${paths.config} (configcheck ok)`);
}

function writeData(mountpoint: string, bytes: number) {
  const name = `file-${Date.now()}-${randomBytes(3).toString("hex")}`;
  writeFileSync(join(mountpoint, name), randomBytes(bytes));
}

function mountpointOf(ds: string): string | null {
  const r = run(["zfs", "get", "-H", "-o", "value", "mounted,mountpoint", ds], true);
  const [mounted, mp] = r.out.trim().split("\n");
  return r.ok && mounted === "yes" && mp?.startsWith("/") ? mp : null;
}

function up(configOnly: boolean) {
  if (configOnly) return writeConfig();
  requireRoot();
  for (const pool of [SRC, DST])
    if (poolExists(pool)) die(`pool ${pool} already exists; run down first`);
  if (existsSync(paths.config)) die(`${WORKDIR} already set up; run down first`);

  mkdirSync(WORKDIR, { recursive: true, mode: 0o700 });
  for (const pool of [SRC, DST]) {
    writeFileSync(paths.img(pool), "");
    truncateSync(paths.img(pool), POOL_SIZE);
    mkdirSync(paths.mnt(pool), { recursive: true });
    run(["zpool", "create", "-o", "cachefile=none", "-O", "compression=lz4",
      "-m", paths.mnt(pool), pool, paths.img(pool)]);
    console.log(`pool ${pool}: ${paths.img(pool)}`);
  }

  writeFileSync(paths.encKey, randomBytes(16).toString("hex"), { mode: 0o600 });
  for (const d of DATASETS) {
    const enc = d.encrypted
      ? ["-o", "encryption=on", "-o", "keyformat=passphrase", "-o", `keylocation=file://${paths.encKey}`]
      : [];
    run(["zfs", "create", ...enc, `${SRC}/${d.rel}`]);
  }
  run(["zfs", "create", `${DST}/sink`]);
  churn(false);
  writeConfig();

  console.log(`
Ready. Next:
  sudo bun ${import.meta.path} daemon   # in its own terminal
  sudo bun ${import.meta.path} status   # or wait ~1 min, then: verify
Log: ${paths.log}
Metrics: http://127.0.0.1:${PORT + 1}/metrics`);
}

/**
 * Run the daemon in the foreground, copying its output to the terminal and
 * to the log file, and record its pid so `down` can stop it. The original
 * zrepl has no file log outlet and no `signal shutdown`.
 */
async function daemon(): Promise<number> {
  requireRoot();
  if (!existsSync(paths.config)) die("not set up; run up first");
  const p = Bun.spawn(zrepl("daemon"), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  writeFileSync(paths.pid, `${p.pid}\n`);
  const log = Bun.file(paths.log).writer();
  const tee = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    for await (const chunk of stream) {
      out.write(chunk);
      log.write(chunk);
      log.flush();
    }
  };
  const stop = () => p.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.all([tee(p.stdout, process.stdout), tee(p.stderr, process.stderr)]);
  const code = await p.exited;
  await log.end();
  rmSync(paths.pid, { force: true });
  return code;
}

function churn(announce = true) {
  requireRoot();
  for (const d of DATASETS) {
    const mp = mountpointOf(`${SRC}/${d.rel}`);
    if (mp) writeData(mp, 1 << 20);
  }
  if (announce) console.log("wrote 1 MiB into each source dataset");
}

function snapshots(ds: string): Map<string, string> {
  const r = run(["zfs", "list", "-H", "-p", "-t", "snapshot", "-o", "name,guid",
    "-s", "createtxg", "-d", "1", ds], true);
  const m = new Map<string, string>();
  if (!r.ok) return m;
  for (const line of r.out.trim().split("\n").filter(Boolean)) {
    const [name, guid] = line.split("\t");
    m.set(guid!, name!.split("@")[1]!);
  }
  return m;
}

function verify() {
  requireRoot();
  let failed = 0;
  for (const d of DATASETS) {
    const src = `${SRC}/${d.rel}`;
    const dst = destOf(d.rel);
    const dstExists = run(["zfs", "list", "-H", "-o", "name", dst], true).ok;
    let status: string;
    if (d.expect === "excluded") {
      status = dstExists ? "FAIL  excluded but present on destination" : "ok    excluded";
    } else if (!dstExists) {
      status = "FAIL  not on destination";
    } else {
      const srcSnaps = [...snapshots(src)];
      const dstGuids = snapshots(dst);
      const lastCommon = srcSnaps.findLastIndex(([guid]) => dstGuids.has(guid));
      const behind = srcSnaps.length - 1 - lastCommon;
      if (lastCommon < 0) status = "FAIL  no snapshot in common";
      else if (behind > 0) status = `lag   ${behind} snapshot(s) behind (${srcSnaps.at(-1)![1]})`;
      else status = `ok    up to date (${srcSnaps.at(-1)![1]})`;
    }
    if (status.startsWith("FAIL")) failed++;
    console.log(`${status.padEnd(60)} ${src}`);
  }
  if (failed) die(`${failed} dataset(s) failed verification`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon() {
  if (!existsSync(paths.pid)) return;
  const pid = Number(readFileSync(paths.pid, "utf8").trim());
  if (!pid || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 60 && alive(pid); i++) await Bun.sleep(500);
  if (alive(pid)) die(`zrepl daemon ${pid} still running 30s after SIGTERM`);
  console.log(`stopped zrepl daemon ${pid}`);
}

async function down() {
  requireRoot();
  await stopDaemon();
  for (const pool of [SRC, DST]) {
    if (!poolExists(pool)) continue;
    const vdevs = run(["zpool", "list", "-v", "-H", "-P", pool]).out
      .split("\n").map((l) => l.trim().split("\t")[0]!).filter((n) => n.startsWith("/"));
    if (!vdevs.length || !vdevs.every((v) => v.startsWith(`${WORKDIR}/`)))
      die(`pool ${pool} has vdevs outside ${WORKDIR} (${vdevs.join(", ")}); refusing to destroy`);
    run(["zpool", "destroy", "-f", pool]);
    console.log(`destroyed pool ${pool}`);
  }
  rmSync(WORKDIR, { recursive: true, force: true });
  console.log(`removed ${WORKDIR}`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "up": up(args.includes("--config-only")); break;
  case "daemon": process.exit(await daemon());
  case "status": {
    const mode = process.stdout.isTTY ? [] : ["--mode", "raw"];
    process.exit(await runInteractive(zrepl("status", ...mode)));
  }
  case "wakeup":
    requireRoot();
    for (const job of [PUSH_JOB, PUSH_ENC_JOB]) run(zrepl("signal", "wakeup", job));
    console.log("woke push jobs");
    break;
  case "churn": churn(); break;
  case "verify": verify(); break;
  case "down": await down(); break;
  default:
    console.error("usage: bun fork/testpool.ts {up [--config-only]|daemon|status|wakeup|churn|verify|down}");
    process.exit(2);
}
