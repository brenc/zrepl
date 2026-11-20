# Fork workflow

This repo (`brenc/zrepl`) is a downstream fork of the original
[`zrepl/zrepl`](https://github.com/zrepl/zrepl). We track its `master`, build
our own binaries from our `main`, and carry our own fixes.

Until 2026-11-20 this repo tracked the `dsh2dsh/zrepl` rewrite instead. That
history is kept on the `archive/dsh2dsh-main` branch and the
`archive/dsh2dsh-main-2026-11-20` tag. The reasons for switching are in the
private notes repo.

## Remotes and branches

| Name | What it is |
|------|------------|
| `origin` | `github.com/brenc/zrepl`, ours |
| `upstream` | `github.com/zrepl/zrepl`, default branch `master` |
| `dsh2dsh` | `github.com/dsh2dsh/zrepl`, reference only; never merged |
| `main` | upstream + our commits. We build and deploy from this. |
| `pr/<topic>` | One upstream PR each, cut from `upstream/master`. |

Setup on a fresh clone:

```sh
git remote add upstream https://github.com/zrepl/zrepl.git
git remote add dsh2dsh https://github.com/dsh2dsh/zrepl.git
git fetch upstream
git config alias.pr-check '!git show main:fork/check-pr-branch.sh | sh -s --'
```

## Fork-only paths

These live on `main` and must never appear in a PR branch:

- `AGENTS.md`, `CLAUDE.md`, `.agents/`, `REVIEW.md`
- `.claude/`, except `.claude/commands/`, which upstream owns
- `FORK.md` (this file)
- `fork/` (tooling such as `fork/check-pr-branch.sh`)

The security audit and roadmap are kept out of this public repo, in the
private `brenc/zrepl-notes`, because they describe unfixed vulnerabilities.

Put any new fork-only material under `fork/` so this list stays short. If you
add a path elsewhere, add it here and to the pattern in
`fork/check-pr-branch.sh`.

## Syncing from upstream

Upstream moves slowly (releases are months or years apart), so check monthly.

1. `git fetch upstream`
2. Review what's new before merging:
   `git log main..upstream/master` and
   `git diff $(git merge-base main upstream/master) upstream/master`.
   Record the result in `security_audit.md` in `brenc/zrepl-notes`
   (reviewed range, findings).
3. `git switch main && git merge upstream/master`
   (commit message: `chore: merge upstream zrepl/zrepl master`)
4. `make vet && make lint && make test-go`, and the platform tests on a ZFS
   host (see `AGENTS.md`).
5. `git push origin main`
6. Production builds come from a tag on `main` that passed the steps above,
   never straight from upstream.

## Carrying our own changes

We fix things on `main` whether or not upstream takes them. To keep syncs
cheap:

- One small commit per fix, with a clear subject, so a sync review can spot
  it.
- Prefer new files over edits to upstream files where it's natural.
- List carried fixes in `brenc/zrepl-notes` so each sync can check they
  survived.

Features ported from `dsh2dsh/zrepl` are reimplemented by hand: the two
codebases share almost no code, so its commits don't apply.

## Sending a PR upstream

Optional. Do it when a fix is useful to everyone and small enough to review.

1. Start from upstream, not `main`:

   ```sh
   git fetch upstream
   git switch -c pr/<topic> upstream/master
   ```

2. Make the change, following upstream's commit style (`git log upstream/master`),
   not our Conventional Commits convention.
3. Run the guard. It fails on fork-only paths, merge commits, or any commit
   that came from our `main`:

   ```sh
   git pr-check
   ```

   `fork/` doesn't exist on a PR branch, so the script is run from `main`
   through the alias set up above.
4. Push and open the PR:

   ```sh
   git push -u origin pr/<topic>
   gh pr create -R zrepl/zrepl --base master --head brenc:pr/<topic>
   ```

5. Get the fix into our build without waiting:
   `git switch main && git cherry-pick <sha>`. If upstream merges it, the next
   sync deduplicates it; if they change it, take their version on merge.

### Rules

- **Never** merge or cherry-pick from `main` into a `pr/` branch.
- **Never** open a PR from `main`.
- To update a PR branch with newer upstream, rebase it:
  `git rebase upstream/master`.
- Before pushing, read the full `git diff upstream/master...HEAD` yourself.
- Don't send security findings as public PRs or issues before checking how
  upstream wants them reported.
- Say plainly in the PR when it was written with AI help. Upstream's
  maintainer uses Claude for release work, but disclosure is still owed.
