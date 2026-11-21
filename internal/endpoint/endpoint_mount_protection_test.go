package endpoint

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/zrepl/zrepl/internal/zfs"
	zfsprop "github.com/zrepl/zrepl/internal/zfs/property"
)

type props = map[zfsprop.Property]string

func TestMountProtectionByStreamType(t *testing.T) {
	tcs := map[string]struct {
		streamType zfs.SendStreamDatasetType
		goos       string
		want       props
	}{
		"filesystem freebsd": {zfs.SendStreamFilesystem, "freebsd", props{
			"mountpoint": "none", "canmount": "off", "volmode": "none",
		}},
		"filesystem linux": {zfs.SendStreamFilesystem, "linux", props{
			"mountpoint": "none", "canmount": "off", "volmode": "none",
			"org.openzfs.systemd:ignore": "on",
		}},
		// zfs recv of a zvol fails on -o mountpoint or -o canmount.
		"volume linux": {zfs.SendStreamVolume, "linux", props{
			"volmode": "none",
		}},
	}
	for name, tc := range tcs {
		t.Run(name, func(t *testing.T) {
			got := mountProtection(zfs.RecvOptions{}, tc.streamType, tc.goos)
			assert.True(t, got.NoMount)
			assert.Equal(t, tc.want, got.OverrideProperties)
			assert.Empty(t, got.InheritProperties)
		})
	}
}

func TestMountProtectionKeepsUserSettings(t *testing.T) {
	userOverride := props{"mountpoint": "/backup", "readonly": "on"}
	in := zfs.RecvOptions{
		RollbackAndForceRecv: true,
		SavePartialRecvState: true,
		InheritProperties:    []zfsprop.Property{"canmount", "org.openzfs.systemd:ignore"},
		OverrideProperties:   userOverride,
	}

	got := mountProtection(in, zfs.SendStreamFilesystem, "linux")

	assert.True(t, got.NoMount)
	assert.True(t, got.RollbackAndForceRecv)
	assert.True(t, got.SavePartialRecvState)
	assert.Equal(t, in.InheritProperties, got.InheritProperties)
	// A property in both -o and -x makes zfs recv fail, so inherited ones
	// must not get a default override.
	assert.Equal(t, props{"mountpoint": "/backup", "readonly": "on", "volmode": "none"}, got.OverrideProperties)

	// The receiver config's map is shared across receives.
	assert.Equal(t, props{"mountpoint": "/backup", "readonly": "on"}, userOverride)
	got.OverrideProperties["x"] = "y"
	assert.NotContains(t, userOverride, zfsprop.Property("x"))
}
