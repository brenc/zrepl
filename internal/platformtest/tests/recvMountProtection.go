package tests

import (
	"fmt"
	"os"
	"path"
	"runtime"

	"github.com/kr/pretty"
	"github.com/stretchr/testify/require"

	"github.com/zrepl/zrepl/internal/daemon/filters"
	"github.com/zrepl/zrepl/internal/endpoint"
	"github.com/zrepl/zrepl/internal/platformtest"
	"github.com/zrepl/zrepl/internal/replication/logic"
	"github.com/zrepl/zrepl/internal/replication/logic/pdu"
	"github.com/zrepl/zrepl/internal/zfs"
)

// Without mount protection, a sender that sends properties chooses where
// the receiver mounts its data. The sender's datasets here point at a
// directory outside the receiver's root_fs.
type mountProtectionSetup struct {
	disableProtection bool
	volume            bool
}

func ReplicationMountProtectionFilesystem(ctx *platformtest.Context) {
	implReplicationMountProtection(ctx, mountProtectionSetup{})
}

func ReplicationMountProtectionVolume(ctx *platformtest.Context) {
	implReplicationMountProtection(ctx, mountProtectionSetup{volume: true})
}

func ReplicationMountProtectionDisabledMountsSenderMountpoint(ctx *platformtest.Context) {
	implReplicationMountProtection(ctx, mountProtectionSetup{disableProtection: true})
}

func implReplicationMountProtection(ctx *platformtest.Context, setup mountProtectionSetup) {
	target, err := os.MkdirTemp("", "zreplplatformtest.mountprotection.")
	require.NoError(ctx, err)
	defer os.RemoveAll(target)

	var createSender string
	if setup.volume {
		createSender = `R zfs create -s -V 16M -o volmode=dev "${ROOTDS}/sender/a"`
	} else {
		// Unmounted on the sender, so the receiver is free to mount at the
		// same path. The child inherits a hostile mountpoint as well.
		createSender = fmt.Sprintf(`
			R  zfs create -o canmount=on -o mountpoint=%s -o org.openzfs.systemd:wanted-by=multi-user.target "${ROOTDS}/sender/a"
			+  "sender/a/child"
			R  zfs unmount "${ROOTDS}/sender/a"
		`, target)
	}

	platformtest.Run(ctx, platformtest.PanicErr, ctx.RootDataset, `
		CREATEROOT
		+  "sender"
		`+createSender+`
		+  "receiver"
		R  zfs create -p "${ROOTDS}/receiver/${ROOTDS}/sender"
	`)

	sfs := ctx.RootDataset + "/sender/a"
	rfsRoot := ctx.RootDataset + "/receiver"
	mustSnapshot(ctx, sfs+"@1")
	sfilter := filters.NewDatasetMapFilter(2, true)
	mustAddToSFilter(ctx, sfilter, sfs)
	if !setup.volume {
		mustSnapshot(ctx, sfs+"/child@1")
		mustAddToSFilter(ctx, sfilter, sfs+"/child")
	}

	rep := replicationInvocation{
		sjid:      endpoint.MustMakeJobID("sender-job"),
		rjid:      endpoint.MustMakeJobID("receiver-job"),
		sfilter:   sfilter,
		rfsRoot:   rfsRoot,
		guarantee: pdu.ReplicationConfigProtectionWithKind(pdu.ReplicationGuaranteeKind_GuaranteeNothing),
		senderConfigHook: func(c *endpoint.SenderConfig) {
			c.SendProperties = true
		},
		receiverConfigHook: func(c *endpoint.ReceiverConfig) {
			c.DisableMountProtection = setup.disableProtection
		},
	}

	replicate := func() {
		r := rep.Do(ctx)
		ctx.Logf("\n%s", pretty.Sprint(r))
		require.Len(ctx, r.Attempts, 1)
		require.Nil(ctx, r.Attempts[0].PlanError)
		for _, fs := range r.Attempts[0].Filesystems {
			require.Nil(ctx, fs.PlanError, fs.Info.Name)
			require.Nil(ctx, fs.StepError, fs.Info.Name)
		}
	}

	// Initial full receive, then an incremental one into the existing
	// dataset: both must apply the overrides without failing. Without
	// protection the incremental fails anyway: mounting the child creates
	// its mountpoint directory inside the mounted parent.
	replicate()
	if !setup.disableProtection {
		mustSnapshot(ctx, sfs+"@2")
		if !setup.volume {
			mustSnapshot(ctx, sfs+"/child@2")
		}
		replicate()
	}

	rfs := path.Join(rfsRoot, sfs)
	get := func(fs, prop string) zfs.PropertyValue {
		props, err := zfs.ZFSGet(ctx, mustDatasetPath(fs), []string{prop})
		require.NoError(ctx, err)
		return props.GetDetails(prop)
	}
	requireLocal := func(fs, prop, value string) {
		v := get(fs, prop)
		require.Equal(ctx, zfs.SourceLocal, v.Source, "%s %s", fs, prop)
		require.Equal(ctx, value, v.Value, "%s %s", fs, prop)
	}

	if setup.volume {
		requireLocal(rfs, "volmode", "none")
		return
	}

	if setup.disableProtection {
		// The pre-fix behavior: zfs recv mounts the sender's choice.
		require.Equal(ctx, target, get(rfs, "mountpoint").Value)
		require.Equal(ctx, "yes", get(rfs, "mounted").Value)
		platformtest.Run(ctx, platformtest.PanicErr, ctx.RootDataset, `R zfs unmount -f "${ROOTDS}/receiver/${ROOTDS}/sender/a/child"`)
		platformtest.Run(ctx, platformtest.PanicErr, ctx.RootDataset, `R zfs unmount -f "${ROOTDS}/receiver/${ROOTDS}/sender/a"`)
		return
	}

	for _, fs := range []string{rfs, rfs + "/child"} {
		requireLocal(fs, "mountpoint", "none")
		requireLocal(fs, "canmount", "off")
		requireLocal(fs, "volmode", "none")
		require.Equal(ctx, "no", get(fs, "mounted").Value, fs)
		if runtime.GOOS == "linux" {
			requireLocal(fs, "org.openzfs.systemd:ignore", "on")
		}
	}
	entries, err := os.ReadDir(target)
	require.NoError(ctx, err)
	require.Empty(ctx, entries, "nothing may be mounted at the sender's mountpoint")
}

// A stream that ends before mount protection can read its header must
// leave a placeholder receive target as it was, so that the next attempt
// can still replace it with `zfs recv -F`.
func ReplicationMountProtectionTruncatedHeaderKeepsPlaceholder(ctx *platformtest.Context) {
	platformtest.Run(ctx, platformtest.PanicErr, ctx.RootDataset, `
		CREATEROOT
		+  "sender"
		+  "sender/a"
		+  "sender/a@1"
		+  "receiver"
		R  zfs create -p "${ROOTDS}/receiver/${ROOTDS}/sender"
	`)

	sfs := ctx.RootDataset + "/sender/a"
	rfsRoot := ctx.RootDataset + "/receiver"
	rfs := mustDatasetPath(path.Join(rfsRoot, sfs))
	err := zfs.ZFSCreatePlaceholderFilesystem(ctx, rfs, mustDatasetPath(path.Dir(rfs.ToString())), zfs.FilesystemPlaceholderCreateEncryptionInherit)
	require.NoError(ctx, err)

	truncate := true
	rep := replicationInvocation{
		sjid:      endpoint.MustMakeJobID("sender-job"),
		rjid:      endpoint.MustMakeJobID("receiver-job"),
		sfs:       sfs,
		rfsRoot:   rfsRoot,
		guarantee: pdu.ReplicationConfigProtectionWithKind(pdu.ReplicationGuaranteeKind_GuaranteeNothing),
		interceptSender: func(e *endpoint.Sender) logic.Sender {
			if !truncate {
				return e
			}
			return &PartialSender{Sender: e, failAfterByteCount: 100}
		},
	}

	requirePlaceholder := func(want bool) {
		st, err := zfs.ZFSGetFilesystemPlaceholderState(ctx, rfs)
		require.NoError(ctx, err)
		require.True(ctx, st.FSExists)
		require.Equal(ctx, want, st.IsPlaceholder)
	}
	requirePlaceholder(true)

	r := rep.Do(ctx)
	ctx.Logf("\n%s", pretty.Sprint(r))
	require.Len(ctx, r.Attempts, 1)
	require.Len(ctx, r.Attempts[0].Filesystems, 1)
	stepErr := r.Attempts[0].Filesystems[0].StepError
	require.NotNil(ctx, stepErr)
	require.Contains(ctx, stepErr.Err, "mount protection")
	requirePlaceholder(true)

	truncate = false
	r = rep.Do(ctx)
	ctx.Logf("\n%s", pretty.Sprint(r))
	require.Len(ctx, r.Attempts, 1)
	require.Len(ctx, r.Attempts[0].Filesystems, 1)
	require.Nil(ctx, r.Attempts[0].Filesystems[0].Error())
	requirePlaceholder(false)
}
