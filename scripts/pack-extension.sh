#!/bin/sh
# Zip the browser extension for the Chrome Web Store: dist/xyznot-extension-<version>.zip
set -e
cd "$(dirname "$0")/.."
v=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
rm -f "dist/xyznot-extension-$v.zip"
(cd extension && zip -qr "../dist/xyznot-extension-$v.zip" . -x '.*')
echo "dist/xyznot-extension-$v.zip"
