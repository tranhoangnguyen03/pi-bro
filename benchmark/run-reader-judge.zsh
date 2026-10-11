#!/bin/zsh
set -eu
set +x
if (( $# < 2 || $# % 2 != 0 )); then
  print -u2 'Usage: run-reader-judge.zsh RUN_DIRECTORY FINGERPRINT [RUN_DIRECTORY FINGERPRINT ...]'
  exit 2
fi
runs=("$@")
cd "${0:A:h}/.."
unset NODE_OPTIONS NODE_PATH HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
trap 'unset TYPESAFE_API_KEY' EXIT INT TERM
read -rs 'TYPESAFE_API_KEY?Jev API key (hidden): '
printf '\n'
export TYPESAFE_API_KEY
# One key prompt for every run; each run still needs its own approval fingerprint.
for (( i = 1; i < ${#runs}; i += 2 )); do
  node --experimental-strip-types benchmark/reader.ts judge "${runs[i]:A}" "${runs[i+1]}"
done
unset TYPESAFE_API_KEY
for (( i = 1; i < ${#runs}; i += 2 )); do
  node --experimental-strip-types benchmark/reader.ts report "${runs[i]:A}"
done
