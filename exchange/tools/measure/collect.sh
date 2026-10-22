#!/bin/bash
# usage: collect.sh <label> <variant>  -> hers-<label>-<variant>.json, annotate-<label>-<variant>.json, judge-ctx-<label>-<variant>.json
SPO=/c/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad
R=/c/Users/XG/Desktop/Project/qqbot-claude2/runtime/sim
L=$1; V=$2
node $SPO/prep-hers2.cjs $SPO/hers-$L-$V.json $R/*-$L-$V-1 $R/*-$L-$V-2 $R/*-$L-$V-3
cd /c/Users/XG/Desktop/Project/qqbot-claude2/packages/bot
node $SPO/annotate.mts $L-$V $SPO/hers-$L-$V.json | head -1
node $SPO/judge-ctx.mts $SPO/hers-$L-$V.json $L-$V | tail -1
