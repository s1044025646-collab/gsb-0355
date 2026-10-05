$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$out = Join-Path $PWD 'data\serve.out'
$err = Join-Path $PWD 'data\serve.err'
$proc = Start-Process -FilePath (Get-Command npx.cmd).Path `
  -ArgumentList 'tsx','src/cli.ts','serve','--port','0' `
  -RedirectStandardOutput $out -RedirectStandardError $err `
  -PassThru -WindowStyle Hidden
try {
  $port = $null
  for ($i = 0; $i -lt 20 -and -not $port; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $out) {
      $m = Select-String -Path $out -Pattern 'http://127\.0\.0\.1:(\d+)'
      if ($m) { $port = $m.Matches[0].Groups[1].Value }
    }
  }
  if (-not $port) { throw "服务未在预期时间内启动；见 $err" }
  Write-Host "PORT=$port"
  Invoke-RestMethod "http://127.0.0.1:$port/health" | ConvertTo-Json -Compress
  $body = @{ pairId='smoke-pair'; clientLabel='C'; serverLabel='S' } | ConvertTo-Json
  Invoke-RestMethod "http://127.0.0.1:$port/api/pairs" -Method Post -ContentType 'application/json' -Body $body | ConvertTo-Json -Compress
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
