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
2.3 and 2.4. None of it runs on this fork. Run the checks locally, and the
platform tests on a ZFS host, before deploying a build.

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

`fork/testpool.ts` (Bun, Linux and FreeBSD) adds a whole-daemon soak test:
file-backed source and destination pools, a push/sink config over localhost
TCP, and a `verify` command that checks every dataset replicated or stayed
excluded as intended. Pool commands need root.

Any change to send, receive, replication planning, pruning or dataset
filtering needs a unit or platform test for the changed behavior, and a run
of the platform tests before it ships.

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
