package zfs

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

// SendStreamDatasetType is the type of the first dataset in a send stream.
// `zfs recv` decides from it which `-o` properties it accepts, so a receiver
// that builds type-specific overrides must read the same bytes.
type SendStreamDatasetType int

const (
	// SendStreamFilesystem is a stream whose first dataset is a filesystem.
	SendStreamFilesystem SendStreamDatasetType = iota + 1
	// SendStreamVolume is a stream whose first dataset is a zvol.
	SendStreamVolume
)

func (t SendStreamDatasetType) String() string {
	switch t {
	case SendStreamFilesystem:
		return "filesystem"
	case SendStreamVolume:
		return "volume"
	default:
		return fmt.Sprintf("SendStreamDatasetType(%d)", int(t))
	}
}

// Every record starts with a fixed-size dmu_replay_record (OpenZFS
// include/sys/zfs_ioctl.h): uint32 drr_type, uint32 drr_payloadlen, then a
// union. For DRR_BEGIN the union is drr_begin: uint64 drr_magic,
// uint64 drr_versioninfo, uint64 drr_creation_time,
// uint32 drr_type (dmu_objset_type_t), uint32 drr_flags, ...
//
// A compound stream (`zfs send -p` or `-R`) is a BEGIN record with a packed
// nvlist payload, an END record, and then one ordinary stream per dataset.
const (
	sendStreamRecordLen = 312

	sendStreamOffPayloadLen  = 4
	sendStreamOffMagic       = 8
	sendStreamOffVersionInfo = 16
	sendStreamOffObjsetType  = 32

	drrBegin = 0
	drrEnd   = 5

	dmuBackupMagic uint64 = 0x2F5bacbac

	dmuCompoundStream = 2 // DMU_GET_STREAM_HDRTYPE(drr_versioninfo)

	dmuOSTZFS  = 2 // DMU_OST_ZFS
	dmuOSTZVOL = 3 // DMU_OST_ZVOL
)

// ReadSendStreamDatasetType reads the start of a `zfs send` stream from r
// up to and including the BEGIN record of its first dataset, and returns
// that dataset's type. Both byte orders are accepted, as `zfs recv` does.
//
// The returned bytes are everything read from r. The caller must put them
// back in front of the rest of the stream before handing it to `zfs recv`.
//
// maxPayload caps the nvlist payload of a compound stream, which grows with
// the number of snapshots and properties sent and is buffered in memory.
//
// It returns an error if r ends early, the stream is malformed, the payload
// exceeds maxPayload, or the dataset is neither a filesystem nor a zvol.
func ReadSendStreamDatasetType(r io.Reader, maxPayload uint32) (SendStreamDatasetType, []byte, error) {
	var buf bytes.Buffer
	read := func(n int64, what string) ([]byte, error) {
		start := buf.Len()
		if _, err := io.CopyN(&buf, r, n); err != nil {
			return nil, fmt.Errorf("read send stream %s: %w", what, err)
		}
		return buf.Bytes()[start:], nil
	}

	rec, err := read(sendStreamRecordLen, "BEGIN record")
	if err != nil {
		return 0, nil, err
	}
	bo, compound, objsetType, err := parseSendStreamBegin(rec)
	if err != nil {
		return 0, nil, err
	}

	if compound {
		payloadLen := bo.Uint32(rec[sendStreamOffPayloadLen:])
		if payloadLen > maxPayload {
			return 0, nil, fmt.Errorf("send stream header payload is %d bytes, more than the limit of %d", payloadLen, maxPayload)
		}
		if _, err := read(int64(payloadLen), "header payload"); err != nil {
			return 0, nil, err
		}
		end, err := read(sendStreamRecordLen, "END record")
		if err != nil {
			return 0, nil, err
		}
		if recType := bo.Uint32(end); recType != drrEnd {
			return 0, nil, fmt.Errorf("compound send stream header not followed by END record: record type %d", recType)
		}
		sub, err := read(sendStreamRecordLen, "first dataset's BEGIN record")
		if err != nil {
			return 0, nil, err
		}
		var subCompound bool
		_, subCompound, objsetType, err = parseSendStreamBegin(sub)
		if err != nil {
			return 0, nil, err
		}
		if subCompound {
			return 0, nil, fmt.Errorf("nested compound send stream")
		}
	}

	switch objsetType {
	case dmuOSTZFS:
		return SendStreamFilesystem, buf.Bytes(), nil
	case dmuOSTZVOL:
		return SendStreamVolume, buf.Bytes(), nil
	default:
		return 0, nil, fmt.Errorf("send stream has unsupported dataset type %d", objsetType)
	}
}

func parseSendStreamBegin(rec []byte) (bo binary.ByteOrder, compound bool, objsetType uint32, err error) {
	switch dmuBackupMagic {
	case binary.LittleEndian.Uint64(rec[sendStreamOffMagic:]):
		bo = binary.LittleEndian
	case binary.BigEndian.Uint64(rec[sendStreamOffMagic:]):
		bo = binary.BigEndian
	default:
		return nil, false, 0, fmt.Errorf("not a zfs send stream: bad magic %#x", binary.LittleEndian.Uint64(rec[sendStreamOffMagic:]))
	}
	if recType := bo.Uint32(rec); recType != drrBegin {
		return nil, false, 0, fmt.Errorf("send stream does not start with a BEGIN record: record type %d", recType)
	}
	compound = bo.Uint64(rec[sendStreamOffVersionInfo:])&0x3 == dmuCompoundStream
	return bo, compound, bo.Uint32(rec[sendStreamOffObjsetType:]), nil
}
