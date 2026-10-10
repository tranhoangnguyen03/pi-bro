#!/bin/zsh
set -eu
set +x
if (( $# != 2 )); then
  print -u2 'Usage: run-reader-judge.zsh RUN_DIRECTORY FINGERPRINT'
  exit 2
fi
run_directory=${1:A}
fingerprint=$2
cd "${0:A:h}/.."
unset NODE_OPTIONS NODE_PATH HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
trap 'unset TYPESAFE_API_KEY' EXIT INT TERM
read -rs 'TYPESAFE_API_KEY?Jev API key (hidden): '
printf '\n'
export TYPESAFE_API_KEY
node --experimental-strip-types benchmark/reader.ts judge "$run_directory" "$fingerprint"
unset TYPESAFE_API_KEY
node --experimental-strip-types benchmark/reader.ts report "$run_directory"
