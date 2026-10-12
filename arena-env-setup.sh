#!/bin/sh
# Sandbox env rebuild (NOT committed; sandbox state resets between turns).
# Re-erects: pnpm, static ffmpeg/ffprobe, playwright-compatible chromium,
# and the repo install. Requires outbound npm + the E2B proxy CA bridge.
set -e
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
TOOLS=/home/user/tools

corepack enable pnpm 2>/dev/null || true

if [ ! -x "$TOOLS/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg" ]; then
  mkdir -p "$TOOLS/ffm" && cd "$TOOLS/ffm"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install --no-save --silent @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe >/dev/null 2>&1
fi
chmod +x "$TOOLS/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg" "$TOOLS/ffm/node_modules/@ffprobe-installer/linux-x64/ffprobe"
ln -sf "$TOOLS/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg" /usr/local/bin/ffmpeg
ln -sf "$TOOLS/ffm/node_modules/@ffprobe-installer/linux-x64/ffprobe" /usr/local/bin/ffprobe

if [ ! -f /tmp/chromium ]; then
  mkdir -p "$TOOLS/sparticuz" && cd "$TOOLS/sparticuz"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install --no-save --silent @sparticuz/chromium >/dev/null 2>&1
  node -e "(async () => { const c = (await import('@sparticuz/chromium')).default; await c.executablePath(); })();"
  node -e "
    const zlib = require('node:zlib'), fs = require('node:fs');
    const d = zlib.brotliDecompressSync(fs.readFileSync('$TOOLS/sparticuz/node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
    fs.writeFileSync('/tmp/al2023.tar', d);
  "
  mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023 && rm -f /tmp/al2023.tar
fi
cat > /usr/local/bin/google-chrome <<'EOF'
#!/bin/sh
export LD_LIBRARY_PATH=/tmp/al2023/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
export FONTCONFIG_PATH=${FONTCONFIG_PATH:-/etc/fonts}
exec /tmp/chromium "$@"
EOF
chmod +x /usr/local/bin/google-chrome
ln -sf /usr/local/bin/google-chrome /usr/local/bin/google-chrome-stable
sudo mkdir -p /opt/google/chrome 2>/dev/null && sudo ln -sf /usr/local/bin/google-chrome /opt/google/chrome/chrome || true

cd /home/user/K-O-V-E
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile --reporter=append-only 2>&1 | tail -2
fi
echo "ENV READY: $(ffmpeg -version | head -1 | cut -c1-24) | $(/usr/local/bin/google-chrome --version 2>/dev/null || echo 'chrome NOT READY')"
