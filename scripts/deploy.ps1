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

.PARAMETER NodeDir
    Node 安装目录（含 pnpm.cmd）。缺省取 $env:DSH_NODE_DIR。

.PARAMETER PluginDir
    插件安装目录（profile 里 link 到的那个）。缺省取 $env:DSH_CLIS_PLUGIN_DIR。

.PARAMETER ProfileDir
    DSH profile 目录。缺省取 $env:DSH_PROFILE_DIR。

.PARAMETER HostRoot
    DSH 安装目录。缺省取 $env:DSH_INSTALL_DIR。

.PARAMETER RestartRelay
    detached-restart 技能的 restart-relay.mjs 路径。缺省按 dshHome 推导。

.EXAMPLE
    .\scripts\deploy.ps1
    .\scripts\deploy.ps1 -SkipRestart

.NOTES
    本脚本刻意不写死机器路径：路径全部走参数或环境变量，缺省值按
    用户目录推导。要用在不同的机器/目录上，设环境变量或传参数即可。
#>
[CmdletBinding()]
param(
    [switch]$SkipRestart,
    [string]$NodeDir = $env:DSH_NODE_DIR,
    [string]$ProjectRoot,
    [string]$PluginDir = $env:DSH_CLIS_PLUGIN_DIR,
    [string]$ProfileDir = $env:DSH_PROFILE_DIR,
    [string]$HostRoot = $env:DSH_INSTALL_DIR,
    [int]$Port = 3080,
    [string]$RestartRelay
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# —— 环境（缺省值按用户目录推导，不写死本机路径）——
# 项目根由脚本自身位置推导：scripts/ 的上一级。
if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$UserHome = $env:USERPROFILE
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $UserHome '.dsh' }

# pnpm 位置：显式 > PATH > 常见 nvm 安装点。宿主重启后 pnpm 常常不在 PATH，
# 所以这条路必须能自己找到，或者给出可操作的报错。
if (-not $NodeDir) {
    $fromPath = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($fromPath) { $NodeDir = Split-Path $fromPath.Source -Parent }
}
if (-not $NodeDir -or -not (Test-Path (Join-Path $NodeDir 'pnpm.cmd'))) {
    $candidates = @(
        'D:\nvm\v22.23.3',
        'C:\nvm\v22.23.3',
        (Join-Path $UserHome 'AppData\Roaming\nvm\v22.23.3')
    ) | Where-Object { Test-Path (Join-Path $_ 'pnpm.cmd') }
    if ($candidates.Count -gt 0) {
        $NodeDir = $candidates[0]
    } else {
        Write-Host '找不到 pnpm.cmd。传 -NodeDir，或设 $env:DSH_NODE_DIR 指向含 pnpm.cmd 的目录。' -ForegroundColor Red
        exit 1
    }
}

if (-not $PluginDir) {
    $PluginDir = Join-Path $UserHome 'Documents\deepseek-harness\default-workspace\dsh-clis'
}
if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome 'profiles\web' }
if (-not $RestartRelay) {
    $RestartRelay = Join-Path $DshHome 'skills\detached-restart\scripts\restart-relay.mjs'
}
$Pnpm = Join-Path $NodeDir 'pnpm.cmd'

$env:Path = "$NodeDir;" + $env:Path
if ($HostRoot) { $env:DSH_INSTALL_DIR = $HostRoot }
$env:DSH_PROFILE_DIR = $ProfileDir
$env:DSH_CLIS_PLUGIN_DIR = $PluginDir

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

# —— 闸门 6：组装 + 同步到插件目录 ——
# 用 scripts/package.mjs 组装（bundle/ 的 JS + packaging/ 的手写资产），
# 而不是只复制 *.js —— 后者会让 patch / package.json / README / locale
# 只存在于安装目录、仓库里没有源头，克隆仓库无法重建插件。
Write-Step '组装可安装产物（JS + 手写资产 + locale）'
$pkgOut = & $Pnpm exec node scripts/package.mjs 2>&1
if ($LASTEXITCODE -ne 0) {
    $pkgOut | Select-Object -Last 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Fail '组装失败'
}
$pkgOut | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }

Write-Step '同步到插件目录'
$pkgDir = Join-Path $ProjectRoot 'dist-package'
# 逐个删除旧文件（不用递归删除整个目录：safe-delete 中间层对批量删除有拦截）
Get-ChildItem $PluginDir -Recurse -File | ForEach-Object { Remove-Item $_.FullName -Force }
Get-ChildItem $pkgDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($pkgDir.Length + 1)
    $dest = Join-Path $PluginDir $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item $_.FullName $dest -Force
}
$synced = (Get-ChildItem $PluginDir -Recurse -File).Count
Write-Host "  OK  同步 $synced 个文件（含 locale / patch / README）" -ForegroundColor Green

# —— 闸门 7：重启并验证 ——
if ($SkipRestart) {
    # 这里刻意不用 Write-Step：它不是一道闸门，报数会让进度显示成 [8/7]。
    Write-Host ''
    Write-Host '跳过重启（-SkipRestart）' -ForegroundColor Yellow
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
