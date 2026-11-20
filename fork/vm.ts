#!/usr/bin/env bun
/**
 * Disposable QEMU/KVM VMs for testing zrepl against real ZFS on Debian and
 * FreeBSD, without root on the host.
 *
 * Each OS has a baked base image with ZFS loaded at boot. A VM is a
 * copy-on-write overlay of that base, so `down` discards everything and the
 * next `up` starts clean. Root inside the VM is reached over SSH with a key
 * kept in the cache directory.
 *
 * Networking is QEMU user mode: SSH and any listed guest ports are
 * forwarded from 127.0.0.1 on the host. A VM reaches another VM's forwarded
 * port at 10.0.2.2:<host port>, and sees peers' connections as coming from
 * 10.0.2.2. (A shared L2 LAN via QEMU's multicast socket was tried first;
 * FreeBSD's boot hangs on it because its own IPv6 DAD probes loop back.)
 *
 * Usage:
 *   bun fork/vm.ts fetch <os>                  download and verify the image
 *   bun fork/vm.ts bake <os>                   build the base image
 *   bun fork/vm.ts up <name> <os> [port...]    start a VM, forwarding guest ports
 *   bun fork/vm.ts port <name> <guest-port>    print the host port for a guest port
 *   bun fork/vm.ts ssh <name> [cmd...]         run a command as root
 *   bun fork/vm.ts put <name> <src> <dst>      copy a host file into the VM
 *   bun fork/vm.ts get <name> <src> <dst>      copy a VM file to the host
 *   bun fork/vm.ts down <name>                 stop the VM and delete it
 *   bun fork/vm.ts list                        show running VMs
 *
 * <os> is `debian` (13) or `freebsd` (15.1).
 *
 * Requirements: qemu-system-x86_64, qemu-img, cloud-localds, xz, and access
 * to /dev/kvm (the `kvm` group).
 *
 * Environment:
 *   ZRVM_CACHE   images and SSH key (default ~/.cache/zrepl-vm)
 *   ZRVM_RUN     running VM state (default /var/tmp/zrepl-vm-<uid>)
 *   ZRVM_MEM     MiB per VM (default 4096)
 *   ZRVM_CPUS    vCPUs per VM (default 4)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = process.env.ZRVM_CACHE ?? join(homedir(), ".cache", "zrepl-vm");
const RUN = process.env.ZRVM_RUN ?? `/var/tmp/zrepl-vm-${process.getuid?.()}`;
const MEM = process.env.ZRVM_MEM ?? "4096";
const CPUS = process.env.ZRVM_CPUS ?? "4";
const KEY = join(CACHE, "id_ed25519");
const PORT_RANGE = [22200, 22400] as const;

type OS = "debian" | "freebsd";

/**
 * Where each OS image comes from. The checksum file is fetched from the
 * same HTTPS origin as the image, so this guards against corruption, not a
 * compromised mirror.
 */
const IMAGES: Record<OS, {
  url: string;
  sums: string;
  sumName: string;
  algo: "sha512" | "sha256";
  xz: boolean;
}> = {
  debian: {
    url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
    sums: "https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS",
    sumName: "debian-13-genericcloud-amd64.qcow2",
    algo: "sha512",
    xz: false,
  },
  freebsd: {
    url: "https://download.freebsd.org/releases/VM-IMAGES/15.1-RELEASE/amd64/Latest/FreeBSD-15.1-RELEASE-amd64-BASIC-CLOUDINIT-ufs.qcow2.xz",
    sums: "https://download.freebsd.org/releases/VM-IMAGES/15.1-RELEASE/amd64/Latest/CHECKSUM.SHA256",
    sumName: "FreeBSD-15.1-RELEASE-amd64-BASIC-CLOUDINIT-ufs.qcow2.xz",
    algo: "sha256",
    xz: true,
  },
};

const dl = (os: OS) => join(CACHE, "dl", `${os}.qcow2`);
const base = (os: OS) => join(CACHE, `base-${os}.qcow2`);
const vmDir = (name: string) => join(RUN, name);

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function run(argv: string[], opts: { allowFail?: boolean; quiet?: boolean } = {}) {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const res = { ok: p.exitCode === 0, code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  if (!res.ok && !opts.allowFail) die(`${argv.join(" ")} (exit ${p.exitCode})\n${res.err.trim()}`);
  return res;
}

function parseOS(s: string | undefined): OS {
  if (s === "debian" || s === "freebsd") return s;
  return die(`unknown os ${JSON.stringify(s)}; use debian or freebsd`);
}

function ensureKey() {
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  if (!existsSync(KEY)) run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "zrepl-vm", "-f", KEY]);
}

async function fetchImage(os: OS) {
  const img = IMAGES[os];
  mkdirSync(join(CACHE, "dl"), { recursive: true });
  if (existsSync(dl(os))) return console.log(`${os}: ${dl(os)} already present`);
  const sums = await (await fetch(img.sums)).text();
  const want = sums.split("\n").map((l) => {
    const bsd = l.match(/^SHA256 \((.+)\) = ([0-9a-f]+)$/);
    if (bsd) return [bsd[1], bsd[2]];
    const gnu = l.match(/^([0-9a-f]+)\s+\*?(.+)$/);
    return gnu ? [gnu[2], gnu[1]] : [];
  }).find(([n]) => n === img.sumName)?.[1] ?? die(`no checksum for ${img.sumName}`);

  const tmp = `${dl(os)}.part${img.xz ? ".xz" : ""}`;
  console.log(`${os}: downloading ${img.url}`);
  run(["curl", "-sSfL", "-o", tmp, img.url]);
  const got = run([`${img.algo}sum`, tmp]).out.split(/\s/)[0];
  if (got !== want) { rmSync(tmp); die(`${os}: checksum mismatch: got ${got}, want ${want}`); }
  if (img.xz) run(["xz", "-d", tmp]);
  run(["mv", tmp.replace(/\.xz$/, ""), dl(os)]);
  console.log(`${os}: ${dl(os)} verified`);
}

/** Cloud-init user-data: root SSH with our key, no password logins. */
function userData(): string {
  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  return `#cloud-config
disable_root: false
ssh_pwauth: false
runcmd:
  - mkdir -p /root/.ssh
  - chmod 700 /root/.ssh
  - echo '${pub}' > /root/.ssh/authorized_keys
  - chmod 600 /root/.ssh/authorized_keys
  - sed -i.bak -e 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  - service sshd restart || systemctl restart ssh
`;
}

function sshArgs(port: number): string[] {
  return ["-i", KEY, "-p", String(port), "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=3", "-o", "BatchMode=yes"];
}

/** Guest port -> host port forwards of a VM; key 22 is SSH. */
function fwdOf(name: string): Record<string, number> {
  const f = join(vmDir(name), "fwd.json");
  if (!existsSync(f)) die(`no VM named ${name}`);
  return JSON.parse(readFileSync(f, "utf8"));
}

const portOf = (name: string) => fwdOf(name)["22"]!;

function hostPortFor(name: string, guest: number): number {
  return fwdOf(name)[String(guest)] ?? die(`${name} doesn't forward guest port ${guest}`);
}

function freePorts(n: number): number[] {
  const used = new Set(listVMs().flatMap((v) => Object.values(fwdOf(v))));
  const out: number[] = [];
  for (let p = PORT_RANGE[0]; p < PORT_RANGE[1] && out.length < n; p++) if (!used.has(p)) out.push(p);
  if (out.length < n) die("no free host ports");
  return out;
}

function listVMs(): string[] {
  return existsSync(RUN) ? readdirSync(RUN).filter((n) => existsSync(join(vmDir(n), "fwd.json"))) : [];
}

function pidAlive(name: string): number | null {
  const f = join(vmDir(name), "qemu.pid");
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, "utf8").trim());
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

async function boot(name: string, disk: string, guestPorts: number[]): Promise<number> {
  const dir = vmDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seed = join(dir, "seed.iso");
  writeFileSync(join(dir, "user-data"), userData());
  writeFileSync(join(dir, "meta-data"), `instance-id: ${name}-${Date.now()}\nlocal-hostname: ${name}\n`);
  run(["cloud-localds", seed, join(dir, "user-data"), join(dir, "meta-data")]);
  const guests = [22, ...guestPorts];
  const hosts = freePorts(guests.length);
  const fwd = Object.fromEntries(guests.map((g, i) => [String(g), hosts[i]!]));
  writeFileSync(join(dir, "fwd.json"), JSON.stringify(fwd));
  const port = fwd["22"]!;
  const hostfwd = guests.map((g) => `,hostfwd=tcp:127.0.0.1:${fwd[String(g)]}-:${g}`).join("");
  run(["qemu-system-x86_64", "-name", name, "-machine", "q35,accel=kvm", "-cpu", "host",
    "-m", MEM, "-smp", CPUS, "-display", "none", "-daemonize",
    "-pidfile", join(dir, "qemu.pid"), "-serial", `file:${join(dir, "serial.log")}`,
    "-drive", `file=${disk},if=virtio,format=qcow2`,
    "-drive", `file=${seed},if=virtio,format=raw,readonly=on`,
    "-netdev", `user,id=n0${hostfwd}`,
    "-device", "virtio-net-pci,netdev=n0"]);
  await waitSSH(name, port);
  return port;
}

async function waitSSH(name: string, port: number, timeoutS = 300) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(name)) die(`${name}: qemu exited; see ${join(vmDir(name), "serial.log")}`);
    if (run(["ssh", ...sshArgs(port), "root@127.0.0.1", "true"], { allowFail: true }).ok) return;
    await Bun.sleep(2000);
  }
  die(`${name}: no SSH after ${timeoutS}s; see ${join(vmDir(name), "serial.log")}`);
}

function ssh(name: string, cmd: string, allowFail = false) {
  return run(["ssh", ...sshArgs(portOf(name)), "root@127.0.0.1", cmd], { allowFail });
}

async function sshStream(name: string, cmd: string): Promise<number> {
  const p = Bun.spawn(["ssh", ...sshArgs(portOf(name)), "root@127.0.0.1", cmd],
    { stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}

function scp(name: string, from: string, to: string) {
  const a = sshArgs(portOf(name)).map((x) => (x === "-p" ? "-P" : x));
  run(["scp", "-q", ...a, from, to]);
}

async function waitExit(name: string, timeoutS = 120) {
  const deadline = Date.now() + timeoutS * 1000;
  while (pidAlive(name) && Date.now() < deadline) await Bun.sleep(1000);
  const pid = pidAlive(name);
  if (pid) process.kill(pid, "SIGKILL");
}

/** Provisioning commands run once, as root, when baking each base image. */
const PROVISION: Record<OS, string> = {
  debian: [
    "set -eux",
    "export DEBIAN_FRONTEND=noninteractive",
    "sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources",
    "apt-get update -q",
    "apt-get install -yq linux-headers-cloud-amd64 linux-headers-$(uname -r)",
    "apt-get install -yq zfs-dkms zfsutils-linux",
    "modprobe zfs",
    "zfs version",
    "cloud-init clean --logs",
  ].join("\n"),
  freebsd: [
    "set -eux",
    // upstream's platform tests run their setup scripts with bash
    "env ASSUME_ALWAYS_YES=yes pkg bootstrap -f",
    "env ASSUME_ALWAYS_YES=yes pkg install -y bash",
    "sysrc zfs_enable=YES",
    "kldload zfs || true",
    "zfs version",
  ].join("\n"),
};

async function bake(os: OS) {
  ensureKey();
  if (!existsSync(dl(os))) await fetchImage(os);
  const name = `bake-${os}`;
  if (pidAlive(name)) die(`${name} is already running`);
  rmSync(vmDir(name), { recursive: true, force: true });
  const tmp = `${base(os)}.tmp`;
  run(["qemu-img", "convert", "-O", "qcow2", dl(os), tmp]);
  run(["qemu-img", "resize", tmp, "20G"]);
  console.log(`${name}: booting`);
  await boot(name, tmp, []);
  console.log(`${name}: provisioning`);
  const code = await sshStream(name, `sh -c '${PROVISION[os].replaceAll("'", "'\\''")}'`);
  if (code !== 0) die(`${name}: provisioning failed (exit ${code}); VM left running for inspection`);
  ssh(name, "poweroff || shutdown -p now", true);
  await waitExit(name);
  rmSync(vmDir(name), { recursive: true, force: true });
  run(["mv", tmp, base(os)]);
  console.log(`${os}: base image ${base(os)}`);
}

async function up(name: string, os: OS, guestPorts: number[]) {
  ensureKey();
  if (!/^[a-z0-9-]+$/.test(name)) die("name must be lowercase letters, digits and dashes");
  if (guestPorts.some((p) => !(p > 0 && p < 65536 && p !== 22))) die("guest ports must be 1-65535, not 22");
  if (!existsSync(base(os))) die(`no base image for ${os}; run: bun fork/vm.ts bake ${os}`);
  if (existsSync(vmDir(name))) die(`${name} exists; run: bun fork/vm.ts down ${name}`);
  mkdirSync(vmDir(name), { recursive: true, mode: 0o700 });
  const disk = join(vmDir(name), "disk.qcow2");
  run(["qemu-img", "create", "-q", "-f", "qcow2", "-b", base(os), "-F", "qcow2", disk]);
  writeFileSync(join(vmDir(name), "os"), os);
  await boot(name, disk, guestPorts);
  ssh(name, os === "freebsd" ? "kldload -n zfs" : "modprobe zfs");
  const fwd = Object.entries(fwdOf(name)).map(([g, h]) => `${g}->${h}`).join(" ");
  console.log(`${name}: ${os} up, forwards (guest->host) ${fwd}`);
}

async function down(name: string) {
  const pid = pidAlive(name);
  if (pid) {
    ssh(name, "poweroff || shutdown -p now", true);
    await waitExit(name, 30);
  }
  rmSync(vmDir(name), { recursive: true, force: true });
  console.log(`${name}: deleted`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "fetch": await fetchImage(parseOS(args[0])); break;
  case "bake": await bake(parseOS(args[0])); break;
  case "up": await up(args[0] ?? die("missing name"), parseOS(args[1]), args.slice(2).map(Number)); break;
  case "port": console.log(hostPortFor(args[0] ?? die("missing name"), Number(args[1]))); break;
  case "ssh": process.exit(await sshStream(args[0] ?? die("missing name"), args.slice(1).join(" ") || "exec $SHELL -l"));
  case "put": scp(args[0]!, args[1]!, `root@127.0.0.1:${args[2]}`); break;
  case "get": scp(args[0]!, `root@127.0.0.1:${args[1]}`, args[2]!); break;
  case "down": await down(args[0] ?? die("missing name")); break;
  case "list":
    for (const n of listVMs()) {
      const os = existsSync(join(vmDir(n), "os")) ? readFileSync(join(vmDir(n), "os"), "utf8") : "?";
      console.log(`${n.padEnd(20)} ${os.padEnd(8)} ssh ${portOf(n)} ${pidAlive(n) ? "running" : "stopped"} ${JSON.stringify(fwdOf(n))}`);
    }
    break;
  default:
    console.error("usage: bun fork/vm.ts {fetch|bake <os>|up <name> <os> [port...]|port <name> <guest-port>|ssh <name> [cmd]|put|get|down <name>|list}");
    process.exit(2);
}
