# CW32L012 Tools 端到端冒烟检查（PowerShell 5.1+）
# 用法：
#   .\tools\e2e-check.ps1              # 只读检查（status/examples/artifact/logs）
#   .\tools\e2e-check.ps1 -Full        # 追加构建+烧录（需要探针与固件产物）
#   .\tools\e2e-check.ps1 -Port 3678 -Token mysecret
param(
    [int]$Port = 3678,
    [string]$Token = "",
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$headers = @{}
if ($Token -ne "") { $headers["x-cw32-token"] = $Token }

function Invoke-Check {
    param([string]$Name, [string]$Method, [string]$Path, [string]$Body = $null)
    $args = @('-s', '-m', '620', '-X', $Method)
    if ($Token -ne "") { $args += @('-H', "x-cw32-token: $Token") }
    if ($Body) { $args += @('-H', 'Content-Type: application/json', '-d', $Body) }
    $args += "$base$Path"
    $raw = & curl.exe @args
    if ($LASTEXITCODE -ne 0) { Write-Host "  [FAIL] $Name（curl exit $LASTEXITCODE，API 未运行或超时）" -ForegroundColor Red; return $null }
    try { $json = $raw | ConvertFrom-Json } catch { Write-Host "  [FAIL] $Name（响应非 JSON: $raw）" -ForegroundColor Red; return $null }
    if ($json.ok -eq $true) { Write-Host "  [ OK ] $Name" -ForegroundColor Green; return $json }
    else { Write-Host "  [FAIL] $Name（ok=false: $($json.error)）" -ForegroundColor Red; return $null }
}

Write-Host "== CW32L012 Agent API 冒烟检查（$base） =="
$status = Invoke-Check -Name 'GET  /api/status' -Method GET -Path '/api/status'
Invoke-Check -Name 'GET  /api/examples' -Method GET -Path '/api/examples' | Out-Null
Invoke-Check -Name 'GET  /api/artifact' -Method GET -Path '/api/artifact' | Out-Null
Invoke-Check -Name 'GET  /api/logs' -Method GET -Path '/api/logs' | Out-Null

if ($null -ne $status) {
    Write-Host ("  probe={0} mcu={1} artifact={2}" -f $status.probe, $status.mcu, $(if ($status.artifact) { Split-Path $status.artifact.path -Leaf } else { 'none' }))
    Write-Host ("  workspace={0} settingsEpoch={1} lease={2}" -f $status.workspace, $status.settingsEpoch, $(if ($status.lease) { $status.lease } else { 'free' }))
}

if ($Full) {
    Write-Host "== -Full：构建 + 烧录（硬件操作，冲突时返回 409） =="
    $built = Invoke-Check -Name 'POST /api/build' -Method POST -Path '/api/build'
    if ($null -ne $built) {
        Invoke-Check -Name 'POST /api/flash' -Method POST -Path '/api/flash' | Out-Null
    } else {
        Write-Host "  构建失败，跳过烧录" -ForegroundColor Yellow
    }
}

Write-Host "== 完成 =="
