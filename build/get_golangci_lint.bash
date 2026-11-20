#!/usr/bin/env bash
set -euo pipefail
set -x

# golangci-lint recommends against using `go get` and friends to install it

cd "$1"

VERSION=2.15.0
FILENAME=golangci-lint-"$VERSION"-linux-"$GOHOSTARCH".tar.gz

if [ -e "$FILENAME" ]; then
    echo "$FILENAME" already exists 1>&2
    exit 1
fi

wget --continue https://github.com/golangci/golangci-lint/releases/download/v"$VERSION"/"$FILENAME"

stat "$FILENAME"

# Select the correct checksum for the downloaded architecture
case "$GOHOSTARCH" in
    arm64) EXPECTED_SHA256="b4d8f17068b35ee6060cc2f69a16fb48740d706fbba81661c318649c114a6998" ;;
    amd64) EXPECTED_SHA256="9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea" ;;
    *)     echo "Unknown architecture: $GOHOSTARCH" >&2; exit 1 ;;
esac

# Verify checksum explicitly - fails if hash doesn't match
echo "$EXPECTED_SHA256  $FILENAME" | sha256sum -c -

tar -x  --strip-components=1 -f "$FILENAME"

stat ./golangci-lint
