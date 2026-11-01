# 语气起伏 A/B：同一句、同一个参考（RMmiao），IndexTTS vs GPT-SoVITS
# 2026-11-01 用户：「16-RMmiao 差不多，就只缺少真人语气的起伏」
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\22601\Desktop\qqbot-dsh-control\runtime'
$out = Join-Path $root 'voice\prosody-test'
New-Item -ItemType Directory -Force $out | Out-Null
$ref = 'C:\Users\22601\Desktop\她的声音\女声试听\16-RMmiao-256Hz.mp3'
$ff = Join-Path $env:USERPROFILE '.dsh\bin\ffmpeg.exe'

# GPT-SoVITS 的参考要 wav
$refWav = Join-Path $out 'ref.wav'
& $ff -v error -y -i $ref -ar 32000 -ac 1 $refWav

$lines = @(
    '嗯……我在呢。你说吧，我听着。',
    '行啊，那就这样。你先忙，等你回来再说。'
)

# 1) IndexTTS
Push-Location (Join-Path $root 'indextts')
$env:PYTHONPATH = '.'
$env:HF_HOME = Join-Path $root 'indextts\checkpoints\hf_cache'
$i = 0
foreach ($t in $lines) {
    $i++
    & '.\.venv\Scripts\python.exe' say.py --text $t --no-emo --prompt $refWav --out (Join-Path $out "indextts-$i.wav") *> (Join-Path $out "indextts-$i.log")
}
Pop-Location

# 2) GPT-SoVITS（同一句、同一个参考）
Push-Location (Join-Path $root 'gptsovits')
$i = 0
foreach ($t in $lines) {
    $i++
    & '.\.venv\Scripts\python.exe' synth.py $t $refWav '' (Join-Path $out "sovits-$i.wav") *> (Join-Path $out "sovits-$i.log")
}
Pop-Location

Get-ChildItem $out -Filter *.wav | Select-Object Name, Length | Format-Table -AutoSize
