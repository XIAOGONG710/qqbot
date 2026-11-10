# 把 E:\RVC模型 里的模型拆出来，用她的那句话逐个转（2026-11-01 用户找来的模型）
$ErrorActionPreference = 'Continue'
$src = 'E:\RVC模型'
$repo = Split-Path -Parent $PSScriptRoot
$work = Join-Path $repo 'runtime\voice\user-models'
$out = Join-Path $repo 'runtime\voice\user-models-out'
 = $raw
$seven = 'C:\Program Files\7-Zip\7z.exe'
$rvc = Join-Path $repo 'runtime\voice\RVC'
$py = Join-Path $repo 'runtime\voice\venv312\Scripts\python.exe'
New-Item -ItemType Directory -Force $work, $out | Out-Null

# 1) 拆 7z
if (Test-Path $seven) {
    Get-ChildItem $src -Filter *.7z | ForEach-Object {
        $dest = Join-Path $work $_.BaseName
        if (-not (Test-Path $dest)) { & $seven x $_.FullName -o"$dest" -y *> $null }
    }
} else {
    "没有 7-Zip，7z 包跳过"
}

# 2) 收集所有 .pth（含 7z 拆出来的）
$models = @()
$models += Get-ChildItem $src -Recurse -Filter *.pth -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.part$' }
$models += Get-ChildItem $work -Recurse -Filter *.pth -File -ErrorAction SilentlyContinue
"找到 $($models.Count) 个模型"

# 3) 逐个转换（她的那句话）
Push-Location $rvc
$env:PYTHONPATH = '.'
$i = 0
foreach ($m in $models) {
    $i++
    $name = $m.BaseName
    $dst = Join-Path $out ("{0:D2}-{1}.wav" -f $i, $name)
    if (Test-Path $dst) { continue }
    # 有同名/同目录的 .index 就带上（检索特征能提升相似度）
    $idx = Get-ChildItem $m.DirectoryName -Filter *.index -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($idx) {
        & $py -m infer.cli --model $m.FullName --input test-in.wav --output $dst --index $idx.FullName --index-rate 0.75 *> (Join-Path $out "$name.log")
    } else {
        & $py -m infer.cli --model $m.FullName --input test-in.wav --output $dst --index-rate 0 *> (Join-Path $out "$name.log")
    }
    if (Test-Path $dst) { "ok $name" } else { "FAIL $name" }
}
Pop-Location
Get-ChildItem $out -Filter *.wav | Select-Object Name,@{n='KB';e={[math]::Round($_.Length/1KB)}} | Format-Table -AutoSize


