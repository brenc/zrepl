# AGENTS.md

## Project

zrepl: ZFS snapshot, replication and pruning daemon. It runs as root and
destroys snapshots, so correctness bugs here lose backups.

This repo (`brenc/zrepl`) is a downstream fork of the original `zrepl/zrepl`.
Module path `github.com/zrepl/zrepl`; our `go.mod` needs Go 1.26 or newer
(upstream is on 1.24; we moved for the x/net security fix). Pure Go, built with `CGO_ENABLED=0`.
Replication uses gRPC for control messages plus a custom data connection
for send streams.

The `dsh2dsh/zrepl` rewrite is kept as the `dsh2dsh` remote for reference
only. It shares almost no code with this tree; never merge or cherry-pick
from it.

## Fork workflow

Read `FORK.md` before syncing upstream or preparing an upstream PR.

- `main` carries fork-only files (this file, `FORK.md`, `fork/`). They must
  never reach a PR branch; run `git pr-check` before pushing one.
- Upstream PR work happens on `pr/<topic>` branches cut from
  `upstream/master`, never from `main`.
- Don't rename the module path; it would make every upstream merge conflict.
- Keep our changes to upstream-owned files small and in separate commits:
  each one is a possible merge conflict.
- The security audit lives in the private repo `brenc/zrepl-notes`, not
  here. Never write vulnerability details into this public repo.

## Commands

The `Makefile` is the real build, and the same targets run in upstream's
CircleCI.

| Task | Command |
|------|---------|
| Build (host) | `make zrepl-bin` → `artifacts/zrepl-<os>-<arch>` |
| Build (other target) | `make zrepl-bin GOOS=freebsd GOARCH=amd64` |
| Unit tests | `make test-go` |
| Coverage | `make test-go COVER=1` → `artifacts/gotest.cover` |
| Race detector | `CGO_ENABLED=1 go test -race ./...` |
| Vet | `make vet` |
| Lint | `make lint` (pinned golangci-lint 2.15.0) |
| Format | `make format` (goimports) |
| Generate | `make generate` (protoc, enumer, stringer) |
| Platform tests | see Testing |

Single package or test:

```sh
CGO_ENABLED=0 go test ./internal/config/...
CGO_ENABLED=0 go test -run TestFunctionName ./internal/endpoint/...
```

`make lint`, `make format` and `make generate` first run `build/install`,
which downloads pinned tools (golangci-lint, protoc, enumer, stringer,
goimports) into `build/install/`. Needs `wget` and `unzip`, and the
golangci-lint download is linux-only. If lint fails with an `export data
version` typecheck error, the pinned golangci-lint is older than your Go:
bump `VERSION` and the checksums in `build/get_golangci_lint.bash`, then
`rm -rf build/install`. Delete `build/install` after any change to the
pinned tool versions.

The version is stamped from `git describe`. The `dsh2dsh` remote is set to
`--no-tags` because dsh2dsh reuses version numbers like `v0.7.0` for
different commits; if a build reports a wrong version, delete local tags and
`git fetch upstream --tags`.

## CI

Upstream runs CircleCI (`.circleci/config.yml`): lint, vet, unit tests,
builds for several OS/arch pairs, and platform tests on Linux against ZFS
2.3 and 2.4. None of it runs on this fork.

Ours, in GitHub Actions (fork-only, `.github/workflows/fork-*`):

- `fork-ci.yml`: vet, lint, unit tests and the race detector on every push
  to `main`, plus the `fork/` tooling checks.
- `fork-release.yml`: release artifacts on `v*-brenc.*` tags (see
  `FORK.md`).

Neither runs the platform tests (GitHub runners have no ZFS). Run them in
the VMs (see Testing) before tagging a release.

## Testing

Two layers:

- **Unit tests** (`make test-go`): about 19% statement coverage, lowest where
  data safety lives (`endpoint` about 7%, `daemon/snapper` 0%). `pruning`
  (about 73%) and `config` (about 72%) are better.
- **Platform tests** (`internal/platformtest`): run real `zfs` commands on a
  throwaway file-backed pool named `zreplplatformtest` in `/tmp`. They cover
  send/recv, resumable receive and resume tokens, holds, bookmarks,
  replication cursors, rollback and batch destroy. Needs root:

  ```sh
  make test-platform-bin              # or GOOS=freebsd for a FreeBSD host
  sudo make test-platform
  ```

  To run on another host, copy `artifacts/platformtest-<os>-<arch>` and run
  it with `-poolname zreplplatformtest -imagepath /tmp/zreplplatformtest.pool.img
  -mountpoint /tmp/zreplplatformtest.pool`.

### VM tests (no root needed on the host)

`fork/vm.ts` runs disposable QEMU/KVM VMs (Debian 13 with ZFS 2.3, FreeBSD
15.1 with ZFS 2.4) as copy-on-write overlays of baked base images; `down`
discards them. Needs `qemu-system-x86`, `qemu-utils`, `cloud-image-utils`
and membership in the `kvm` group. One-time setup:
`bun fork/vm.ts bake debian && bun fork/vm.ts bake freebsd`.

`fork/soak.ts` drives them. Build first: `make zrepl-bin` and
`make test-platform-bin`, each with `GOOS=linux` and `GOOS=freebsd`
(`GOARCH=amd64`).

```sh
bun fork/soak.ts platform debian      # upstream platform tests, ~1.5 min
bun fork/soak.ts platform freebsd
bun fork/soak.ts topo up              # 3 VMs shaped like production
bun fork/soak.ts topo soak 60         # churn + verify for 60 min
bun fork/soak.ts topo down
```

The topology copies production: `src` (FreeBSD, like store03: snap job and
TLS source), `mid` (Debian, like backup01: TLS pull, TCP source) and `off`
(Debian, like rbackup02: TCP pull). Intervals and grids are scaled to
minutes. `verify` checks each hop's snapshot chain, exclusions, that
received datasets never mount, logged errors, and that daemons are up.
Logs and results land in `/var/tmp/zrepl-vm-<uid>/_soak/`.

`fork/testpool.ts` is the older single-host version (push/sink over
localhost on file-backed pools), for a real ZFS host with root.

Any change to send, receive, replication planning, pruning or dataset
filtering needs a unit or platform test for the changed behavior, and a run
of the platform tests before it ships.

## Fork tooling (Bun)

The TypeScript scripts in `fork/` (`vm.ts`, `soak.ts`, `testpool.ts`, with
shared parsing in `fork/lib/`) are a self-contained Bun project, kept inside
`fork/` so none of it can reach an upstream PR. Run these from `fork/`:

```sh
bun install            # also installs the pre-commit hook
bun run lint:write     # biome (format + lint), dprint (Markdown), tsc
bun run test           # bun test: fork/lib/*.test.ts
```

Run `bun run lint:write` and `bun run test` after changing anything in
`fork/`. The pre-commit hook (`fork/.husky/pre-commit`) runs `bun run lint`
on every commit in this repo.

- Biome: single quotes, 2-space indent, sorted keys and imports; schema from
  `node_modules`. Strict TypeScript with `noUncheckedIndexedAccess`: handle
  `undefined` (`?? die(...)`) instead of using `!`.
- Pure logic goes in `fork/lib/` with a `*.test.ts` next to it; the scripts
  stay thin wrappers around `ssh`, `zfs` and `qemu`.
- JSDoc every exported function and type.
- `bunfig.toml` only installs packages at least 3 days old and runs the
  Socket security scanner on install.

CI (`.github/workflows/fork-ci.yml`) runs the Go checks (vet, lint, unit
tests, race detector) and this tooling's lint and tests on `main`.

## Architecture

- `main.go` → `internal/cli`: cobra CLI and subcommands
- `internal/client`: CLI-side commands (`status` TUI, `signal`, `test`,
  `configcheck`, `migrate`, `stdinserver`, `zfs-abstraction`)
- `internal/daemon`: daemon main, control socket, Prometheus
  - `job`: job types (push, pull, sink, source, snap; active vs passive)
  - `snapper`, `pruner`, `hooks`, `filters` (dataset filter syntax)
- `internal/config`: YAML config parsing (`zrepl/yaml-config`)
- `internal/endpoint`: sender/receiver side of replication over ZFS
- `internal/replication`: `driver` (attempts, retries), `logic` (planning;
  `pdu` holds the protobuf wire types, generated from `pdu.proto`), `report`
- `internal/rpc`: gRPC control connection, `dataconn` for send streams,
  version handshake
- `internal/transport`: `tcp`, `tls`, `ssh` (+stdinserver), `local`
- `internal/pruning`: keep rules (`grid`, `last_n`, `regex`,
  `not_replicated`)
- `internal/zfs`: `zfs` CLI wrappers; `zfscmd` (exec and logging)
- `internal/platformtest`: real-ZFS test harness and tests

`internal/replication/design.md` explains the replication model.

## Code generation

Generated code is committed: `*.pb.go` (protoc), `*_enumer.go` (enumer),
`*_string.go` (stringer). Don't edit them by hand; run `make generate`, which
uses pinned tool versions so the output is reproducible. Upstream CI fails if
the tree is dirty after `make generate`.

## Code conventions

- goimports with local prefix `github.com/zrepl/zrepl`.
- golangci-lint v2 with `revive` (`.golangci.yml`).
- Errors mostly use `github.com/pkg/errors` (`errors.Wrap`) in older code;
  match the file you're in.
- Tests use the standard library and testify.
