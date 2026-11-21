package zfs

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testRecord struct {
	recType    uint32
	payloadLen uint32
	magic      uint64
	versinfo   uint64
	objsetType uint32
}

func (r testRecord) bytes(bo binary.ByteOrder) []byte {
	b := make([]byte, sendStreamRecordLen)
	bo.PutUint32(b, r.recType)
	bo.PutUint32(b[sendStreamOffPayloadLen:], r.payloadLen)
	bo.PutUint64(b[sendStreamOffMagic:], r.magic)
	bo.PutUint64(b[sendStreamOffVersionInfo:], r.versinfo)
	bo.PutUint32(b[sendStreamOffObjsetType:], r.objsetType)
	return b
}

// Header values as `zfs send` 2.3 writes them: versioninfo 0x11 is a
// substream with feature flags, 0x2 a compound stream with objset type 0.
func substreamBegin(objsetType uint32) testRecord {
	return testRecord{recType: drrBegin, magic: dmuBackupMagic, versinfo: 0x11, objsetType: objsetType}
}

func compoundBegin(payloadLen uint32) testRecord {
	return testRecord{recType: drrBegin, payloadLen: payloadLen, magic: dmuBackupMagic, versinfo: dmuCompoundStream}
}

func compoundStream(bo binary.ByteOrder, payloadLen uint32, sub testRecord) []byte {
	var s []byte
	s = append(s, compoundBegin(payloadLen).bytes(bo)...)
	s = append(s, bytes.Repeat([]byte{0xab}, int(payloadLen))...)
	s = append(s, testRecord{recType: drrEnd}.bytes(bo)...)
	return append(s, sub.bytes(bo)...)
}

var trailingData = []byte("rest of the stream")

func TestReadSendStreamDatasetType(t *testing.T) {
	le, be := binary.LittleEndian, binary.BigEndian
	tcs := map[string]struct {
		header []byte
		want   SendStreamDatasetType
	}{
		"filesystem":           {substreamBegin(dmuOSTZFS).bytes(le), SendStreamFilesystem},
		"volume":               {substreamBegin(dmuOSTZVOL).bytes(le), SendStreamVolume},
		"big endian volume":    {substreamBegin(dmuOSTZVOL).bytes(be), SendStreamVolume},
		"send -p filesystem":   {compoundStream(le, 480, substreamBegin(dmuOSTZFS)), SendStreamFilesystem},
		"send -p volume":       {compoundStream(le, 480, substreamBegin(dmuOSTZVOL)), SendStreamVolume},
		"big endian send -p":   {compoundStream(be, 16, substreamBegin(dmuOSTZVOL)), SendStreamVolume},
		"empty payload":        {compoundStream(le, 0, substreamBegin(dmuOSTZFS)), SendStreamFilesystem},
		"payload at the limit": {compoundStream(le, 1024, substreamBegin(dmuOSTZVOL)), SendStreamVolume},
	}
	for name, tc := range tcs {
		t.Run(name, func(t *testing.T) {
			stream := append(append([]byte{}, tc.header...), trailingData...)
			r := bytes.NewReader(stream)

			got, consumed, err := ReadSendStreamDatasetType(r, 1024)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)

			// Nothing past the first dataset's BEGIN record is consumed,
			// and consumed plus the rest is the original stream.
			assert.Equal(t, tc.header, consumed)
			rest := make([]byte, len(trailingData)+1)
			n, _ := r.Read(rest)
			assert.Equal(t, trailingData, rest[:n])
		})
	}
}

// A `send -p` header of a dataset with many snapshots can be larger than
// the receiver's 1 MiB peek buffer.
func TestReadSendStreamDatasetTypeLargePayload(t *testing.T) {
	stream := compoundStream(binary.LittleEndian, 2<<20, substreamBegin(dmuOSTZVOL))
	got, consumed, err := ReadSendStreamDatasetType(bytes.NewReader(stream), 4<<20)
	require.NoError(t, err)
	assert.Equal(t, SendStreamVolume, got)
	assert.Equal(t, stream, consumed)
}

func TestReadSendStreamDatasetTypeRejects(t *testing.T) {
	le := binary.LittleEndian
	with := func(r testRecord, f func(*testRecord)) testRecord { f(&r); return r }
	fs := substreamBegin(dmuOSTZFS)

	tcs := map[string]struct {
		stream  []byte
		errPart string
	}{
		"empty":     {nil, "read send stream BEGIN record: EOF"},
		"truncated": {fs.bytes(le)[:sendStreamRecordLen-1], "BEGIN record: EOF"},
		"bad magic": {with(fs, func(r *testRecord) { r.magic = 0 }).bytes(le), "bad magic"},
		"not BEGIN": {with(fs, func(r *testRecord) { r.recType = 1 }).bytes(le), "BEGIN record: record type 1"},
		"objset type 0": {with(fs, func(r *testRecord) { r.objsetType = 0 }).bytes(le),
			"unsupported dataset type 0"},
		"payload over limit": {compoundStream(le, 1025, fs), "more than the limit of 1024"},
		"truncated payload":  {compoundBegin(1000).bytes(le), "header payload: EOF"},
		"no END record": {
			append(compoundBegin(0).bytes(le), fs.bytes(le)...), "not followed by END record: record type 0"},
		"no substream": {
			append(compoundBegin(0).bytes(le), testRecord{recType: drrEnd}.bytes(le)...), "first dataset's BEGIN record: EOF"},
		"nested compound": {compoundStream(le, 0, compoundBegin(0)), "nested compound"},
		"substream type 4": {
			compoundStream(le, 0, substreamBegin(4)), "unsupported dataset type 4"},
	}
	for name, tc := range tcs {
		t.Run(name, func(t *testing.T) {
			_, consumed, err := ReadSendStreamDatasetType(bytes.NewReader(tc.stream), 1024)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.errPart)
			assert.Nil(t, consumed)
		})
	}
}
