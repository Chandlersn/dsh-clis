<#
.SYNOPSIS
    CLIS 一键部署：跑完七道闸门，全过才同步并重启宿主。

.DESCRIPTION
    为什么要有这个脚本：
    我们踩过的两个致命缺陷（工具返回值含 undefined 被宿主拒绝、
    读未 inject 的 storageDomain 崩溃）**全部逃过了 484 个单元测试**，
    只在真机调用时暴露。所以部署不能只跑测试，必须包含
    「真实调用三个工具并校验返回值」这一步。

    设计原则：任何一步失败立刻停下并报告，绝不带着坏版本继续。
    宁可少部署一次，也不上线一个半死的插件。

.PARAMETER SkipRestart
    只构建与校验，不重启宿主（用于只想确认代码健康时）。

.EXAMPLE
    .\scripts\deploy.ps1
    .\scripts\deploy.ps1 -SkipRestart
#>
[CmdletBinding()]
param(
    [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# —— 环境 ——
$NodeDir = 'D:\nvm\v22.23.3'
$Pnpm = Join-Path $NodeDir 'pnpm.cmd'
$ProjectRoot = 'D:\个人开发\CLIS'
$PluginDir = 'C:\Users\lyq\Documents\deepseek-harness\default-workspace\dsh-clis'
$ProfileDir = 'C:\Users\lyq\.dsh\profiles\web'
$HostRoot = 'D:\dsh'
$Port = 3080
$RestartRelay = 'C:\Users\lyq\.dsh\skills\detached-restart\scripts\restart-relay.mjs'

$env:Path = "$NodeDir;" + $env:Path
$env:DSH_INSTALL_DIR = $HostRoot
$env:DSH_PROFILE_DIR = $ProfileDir

# 让中文输出不乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$stepIndex = 0
$totalSteps = 7

function Write-Step([string]$Title) {
    $script:stepIndex += 1
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $script:stepIndex, $script:totalSteps, $Title) -ForegroundColor Cyan
}

function Fail([string]$Reason) {
    Write-Host ''
    Write-Host "DEPLOY ABORTED: $Reason" -ForegroundColor Red
    Write-Host '未同步、未重启 —— 现有版本保持运行。' -ForegroundColor Yellow
    exit 1
}

function Invoke-Gate([string]$Label, [scriptblock]$Body) {
    & $Body
    if ($LASTEXITCODE -ne 0) { Fail "$Label 失败（exit=$LASTEXITCODE）" }
    Write-Host "  OK  $Label" -ForegroundColor Green
}

Set-Location $ProjectRoot

# —— 闸门 1：类型检查 ——
Write-Step '类型检查（tsc）'
Invoke-Gate 'tsc' { & $Pnpm exec tsc -p tsconfig.json 2>&1 | Out-Null }

# —— 闸门 2：全量测试 ——
Write-Step '全量测试（vitest）'
$cacheDir = Join-Path $ProjectRoot 'node_modules\.vitest-cache'
if (Test-Path $cacheDir) { Remove-Item $cacheDir -Recurse -Force -ErrorAction SilentlyContinue }
$testOutput = & $Pnpm exec vitest run 2>&1
$testExit = $LASTEXITCODE
$summary = ($testOutput | Select-String -Pattern 'Tests\s+(\d+)\s+passed' | Select-Object -Last 1)
if ($testExit -ne 0) {
    $testOutput | Select-String -Pattern 'FAIL|×|AssertionError' | Select-Object -First 15 | ForEach-Object { Write-Host "  $($_.Line)" -ForegroundColor Red }
    Fail 'vitest 失败'
}
Write-Host "  OK  $($summary.Line.Trim())" -ForegroundColor Green

# —— 闸门 3：组件冒烟 ——
Write-Step '组件冒烟（装载/依赖/开关/卸载 32 项）'
$compOut = & $Pnpm exec node scripts/smoke-components.mjs 2>&1
if ($LASTEXITCODE -ne 0) {
    $compOut | Select-String -Pattern 'FAIL' | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.Line)" -ForegroundColor Red }
    Fail '组件冒烟失败'
}
$compPass = ($compOut | Select-String -Pattern 'PASS' | Measure-Object).Count
Write-Host "  OK  $compPass 项通过，SMOKE PASS" -ForegroundColor Green

# —— 闸门 4：工具冒烟（含宿主 isJsonValue 真校验）——
# 这一步是关键：上面两个缺陷都只能在这里被抓到
Write-Step '工具冒烟（含宿主 isJsonValue 无损 JSON 校验）'
$toolOut = & $Pnpm exec node scripts/smoke-tools.mjs 2>&1
if ($LASTEXITCODE -ne 0) {
    $toolOut | Select-String -Pattern 'FAIL|undefined' | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.Line)" -ForegroundColor Red }
    Fail '工具冒烟失败（返回值可能含 undefined，宿主会拒绝）'
}
$toolPass = ($toolOut | Select-String -Pattern 'PASS' | Measure-Object).Count
Write-Host "  OK  $toolPass 项通过，返回值全部无损 JSON" -ForegroundColor Green

# —— 闸门 5：构建 ——
Write-Step '构建 bundle（5 入口 + 共享 chunk）'
Get-ChildItem (Join-Path $ProjectRoot 'bundle') -Filter '*.js' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
$buildOut = & $Pnpm exec node scripts/bundle.mjs 2>&1
if ($LASTEXITCODE -ne 0) {
    $buildOut | Select-Object -Last 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Fail 'esbuild 失败'
}
Write-Host "  OK  $($buildOut | Select-Object -Last 1)" -ForegroundColor Green

# —— 闸门 6：同步到插件目录 ——
Write-Step '同步到插件目录'
Get-ChildItem $PluginDir -Filter '*.js' | ForEach-Object { Remove-Item $_.FullName -Force }
Get-ChildItem (Join-Path $ProjectRoot 'bundle') -File |
    ForEach-Object { Copy-Item $_.FullName $PluginDir -Force }
$synced = (Get-ChildItem $PluginDir -Filter '*.js').Count
Write-Host "  OK  同步 $synced 个文件" -ForegroundColor Green

# —— 闸门 7：重启并验证 ——
if ($SkipRestart) {
    Write-Step '跳过重启（-SkipRestart）'
    Write-Host '  代码已就绪，下次启动宿主时生效。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'DEPLOY OK（未重启）' -ForegroundColor Green
    exit 0
}

Write-Step '重启宿主'
$listener = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING'
$oldPid = ($listener | ForEach-Object { ($_.Line.Trim() -split '\s+')[-1] } | Sort-Object -Unique) -join ','
if (-not $oldPid) { Fail "端口 $Port 上没有监听进程" }
Write-Host "  当前 PID=$oldPid，触发继电器..."

& $Pnpm exec node $RestartRelay $oldPid $Port 5000 2>&1 | Where-Object { $_ -match 'relay' } | ForEach-Object { Write-Host "  $_" }

# 轮询新 PID
$newPid = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    $now = (netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' |
        ForEach-Object { ($_.Line.Trim() -split '\s+')[-1] } | Sort-Object -Unique) -join ','
    if ($now -and $now -ne $oldPid) { $newPid = $now; break }
}
if (-not $newPid) { Fail "30 秒内端口未切换到新进程（旧 PID=$oldPid）" }

# 稳定性：两次采样
Start-Sleep -Seconds 10
$confirm = (netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' |
    ForEach-Object { ($_.Line.Trim() -split '\s+')[-1] } | Sort-Object -Unique) -join ','
if ($confirm -ne $newPid) { Fail "进程不稳定：$newPid -> $confirm" }
Write-Host "  OK  新 PID=$newPid（两次采样一致）" -ForegroundColor Green

Write-Host ''
Write-Host 'DEPLOY OK' -ForegroundColor Green
Write-Host "  宿主已重启，PID=$newPid"
Write-Host "  GUI: http://127.0.0.1:$Port"
Write-Host '  注意：token 每次重启都会变，请从浏览器打开或查 web-3080.log 最后一行 dsh web:'
