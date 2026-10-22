#!/bin/bash
# usage: run-config.sh <variant> <label> <extra flags...>   (3 parallel chunks; waits for completion; uses the heavy lock)
SPO=/c/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad
V=$1; L=$2; shift 2
cd /c/Users/XG/Desktop/Project/qqbot-claude2/packages/bot
for c in 1 2 3; do
  node src/sim/run.ts "C:\Users\XG\AppData\Local\Temp\claude\C--Users-XG-Desktop-Project\3ae87421-f778-4ab6-a257-be927b0e8739\scratchpad\ctx-$V-chunk-$c" --runs 1 --no-memory --shape --agenda --filler --split "$@" --tag "$L-$V-$c" > $SPO/$L-$V-$c.out 2> $SPO/$L-$V-$c.err &
done
wait
echo "done $L $V"
