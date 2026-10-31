#!/usr/bin/env bash
# FixMyPVD's case feed reaches back only 90 days, so fetch it weekly in the background to keep the 311 history unbroken.
# Idempotent: does nothing while a watch is running. Runs at the end of `npm run rebuild`; stop with `kill $(cat data/raw/city_cases_watch.pid)`.
cd "$(dirname "$0")/.." || exit 1
pidf=data/raw/city_cases_watch.pid
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then echo "311 watch already running (pid $(cat "$pidf"))"; exit 0; fi
mkdir -p data/raw
setsid nohup bash -c 'echo $$ > data/raw/city_cases_watch.pid; while true; do date -u +%FT%TZ >> data/raw/city_cases_watch.log; ONLY=city_cases_fixmypvd node scripts/fetch.ts >> data/raw/city_cases_watch.log 2>&1; sleep 604800; done' >/dev/null 2>&1 < /dev/null &
echo "311 watch started"
