package endpoint

import (
	"maps"
	"slices"

	"github.com/zrepl/zrepl/internal/zfs"
	zfsprop "github.com/zrepl/zrepl/internal/zfs/property"
)

// mountProtection returns opts changed so that a received dataset is not
// mounted and not exposed as a block device, whatever properties the send
// stream carries: the sending side doesn't get to decide whether or where
// the receiving host mounts its data.
//
// It adds `zfs recv -u` and, by the type of the stream's first dataset:
//   - filesystem: mountpoint=none, canmount=off, volmode=none, and on Linux
//     org.openzfs.systemd:ignore=on so that zfs-mount-generator(8) ignores
//     the sender's org.openzfs.systemd:* properties
//   - volume: volmode=none
//
// The overrides are type-specific because `zfs recv` of a zvol, with or
// without `send -p`, fails on `-o mountpoint` or `-o canmount`. A
// filesystem still gets volmode=none for a `send -R` stream, whose zvol
// children inherit it; `zfs recv -R` skips overrides that don't apply to a
// child instead of failing. A property the user already set to
// override or inherit keeps the user's setting. opts is not modified; the
// returned options own a fresh OverrideProperties map.
func mountProtection(opts zfs.RecvOptions, streamType zfs.SendStreamDatasetType, goos string) zfs.RecvOptions {
	defaults := map[zfsprop.Property]string{"volmode": "none"}
	if streamType != zfs.SendStreamVolume {
		defaults["mountpoint"] = "none"
		defaults["canmount"] = "off"
		if goos == "linux" {
			defaults["org.openzfs.systemd:ignore"] = "on"
		}
	}

	override := maps.Clone(opts.OverrideProperties)
	if override == nil {
		override = make(map[zfsprop.Property]string, len(defaults))
	}
	for prop, value := range defaults {
		if _, set := override[prop]; set {
			continue
		}
		if slices.Contains(opts.InheritProperties, prop) {
			continue
		}
		override[prop] = value
	}

	opts.OverrideProperties = override
	opts.NoMount = true
	return opts
}
