#!/bin/sh
# Assemble Workers static assets: public/ plus the vendor files the reader loads.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/vendor/pdfjs dist/vendor/marked/lib dist/vendor/katex
cp -R public/. dist/
rsync -a --exclude '*.map' node_modules/pdfjs-dist/build node_modules/pdfjs-dist/web node_modules/pdfjs-dist/cmaps node_modules/pdfjs-dist/standard_fonts dist/vendor/pdfjs/
cp node_modules/marked/lib/marked.esm.js dist/vendor/marked/lib/
rsync -a --exclude '*.map' node_modules/katex/dist/ dist/vendor/katex/
echo "dist: $(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"
