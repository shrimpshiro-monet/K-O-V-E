# Boots (or rebuilds) the E2E harness from scratch after a sandbox reset.
# Everything generated lives under $HARNESS_HOME (default /home/user/kove-e2e-harness);
# THIS directory (inside the repo, untracked) holds the master scripts.
# Usage: sh e2e-harness/bootstrap.sh   (from repo root)
set -e
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
H=${HARNESS_HOME:-/home/user/kove-e2e-harness}
HERE=$(cd "$(dirname "$0")" && pwd)
F=/home/user/tools/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg

sh "$HERE/../arena-env-setup.sh"

mkdir -p "$H/media" "$H/shots" "$H/frames" "$H/tools"
cp "$HERE"/llm-stub.mjs "$HERE"/run.cjs "$HERE"/verify-render.cjs "$H/"

cd "$H/media"
"$F" -y -f lavfi -i "testsrc2=size=1280x720:rate=30,hue=h=210,drawtext=text='GAMEPLAY A':fontcolor=white:fontsize=72:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p" -f lavfi -i "sine=frequency=415" -t 12 -c:v libvpx-vp9 -crf 36 -g 30 -c:a libopus -b:a 96k gameplay-a.webm >/dev/null 2>&1 &
P1=$!
"$F" -y -f lavfi -i "smptehdbars=size=1280x720:rate=30,drawtext=text='TALKING HEAD B':fontcolor=white:fontsize=52:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-th-40,format=yuv420p" -f lavfi -i "sine=frequency=523" -t 12 -c:v libvpx-vp9 -crf 36 -g 30 -c:a libopus -b:a 96k talking-b.webm >/dev/null 2>&1 &
P2=$!
"$F" -y -f lavfi -i "rgbtestsrc=size=1280x720:rate=30,hue=h='240*t',drawtext=text='B-ROLL C':fontcolor=black:fontsize=64:box=1:boxcolor=white@0.6:boxborderw=16:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p" -f lavfi -i "sine=frequency=645" -t 10 -c:v libvpx-vp9 -crf 36 -g 30 -c:a libopus -b:a 96k broll-c.webm >/dev/null 2>&1 &
P3=$!
"$F" -y -f lavfi -i "aevalsrc=0.14*sin(220*2*PI*t)+0.10*sin(277*2*PI*t)+0.09*sin(330*2*PI*t)|0.12*sin(220*2*PI*t)+0.09*sin(277*2*PI*t)+0.08*sin(330*2*PI*t):s=48000,tremolo=f=3,afade=t=in:d=0.8,afade=t=out:st=17:d=1" -t 18 -ar 48000 -ac 2 -c:a pcm_s16le music-bed.wav >/dev/null 2>&1 &
"$F" -y -f lavfi -i "rgbtestsrc=size=1280x720:rate=30,drawtext=text='ZOOM CHECK':fontcolor=black:fontsize=80:box=1:boxcolor=white@0.6:boxborderw=16:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p" -t 6 -c:v libvpx-vp9 -crf 30 -g 60 -an zoomcheck.webm >/dev/null 2>&1 &
P5=$!
wait $P1 $P2 $P3 $P4 $P5

cd "$H/tools"
[ -d node_modules/playwright-core ] || { npm init -y >/dev/null 2>&1; npm install --no-save --silent playwright-core; }

echo "HARNESS READY at $H"
echo "  start stub:  node $H/llm-stub.mjs            # 127.0.0.1:8799"
echo "  start vite:  KOVE_DEV_ALLOW_ALL_HOSTS=1 pnpm dev   # apps/web, 0.0.0.0:5173"
echo "  demo run:    NODE_PATH=$H/tools/node_modules node $H/run.cjs"
echo "  frame proof: NODE_PATH=$H/tools/node_modules node $H/verify-render.cjs"
