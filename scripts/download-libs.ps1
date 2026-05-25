# Download all required library files for the SRM CAPTCHA Solver extension
# Run this script from the PROJECT ROOT (the folder containing extension/)
#
# Usage (PowerShell):
#   cd "path\to\captcha"
#   .\scripts\download-libs.ps1
#
# What this downloads:
#   - Tesseract.js v5 (OCR engine)
#   - Tesseract WASM core
#   - eng.traineddata (English language model ~4MB)
#   - OpenCV.js 4.9 (image processing ~8MB)
#
# Total download size: ~16MB
# All files placed in: extension/libs/

$ErrorActionPreference = "Stop"
$libsDir     = "extension\libs"
$tessdataDir = "extension\libs\tessdata"

# ── Create directories ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "SRM CAPTCHA Solver — Library Downloader" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/6] Creating directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $libsDir     | Out-Null
New-Item -ItemType Directory -Force -Path $tessdataDir | Out-Null
Write-Host "      extension/libs/         ✓" -ForegroundColor Green
Write-Host "      extension/libs/tessdata/ ✓" -ForegroundColor Green

# ── Helper function ───────────────────────────────────────────────────────────

function Download-File {
  param($Url, $OutFile, $Label)
  Write-Host ""
  Write-Host "[$Label] Downloading..." -ForegroundColor Yellow
  Write-Host "      URL:  $Url" -ForegroundColor DarkGray
  Write-Host "      File: $OutFile" -ForegroundColor DarkGray
  try {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    $size = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host "      Done! (${size}MB)" -ForegroundColor Green
  } catch {
    Write-Host "      FAILED: $_" -ForegroundColor Red
    Write-Host "      Please download manually from the URL above." -ForegroundColor Yellow
  }
}

# ── Download Tesseract.js ─────────────────────────────────────────────────────

Download-File `
  "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js" `
  "$libsDir\tesseract.min.js" `
  "2/6"

Download-File `
  "https://unpkg.com/tesseract.js@5/dist/worker.min.js" `
  "$libsDir\tesseract.worker.min.js" `
  "3/6"

Download-File `
  "https://unpkg.com/tesseract.js-core@5/tesseract-core-simd.wasm.js" `
  "$libsDir\tesseract-core.wasm.js" `
  "4/6"

# ── Download Language Data ────────────────────────────────────────────────────

Download-File `
  "https://github.com/naptha/tessdata/raw/gh-pages/4.0.0/eng.traineddata.gz" `
  "$tessdataDir\eng.traineddata.gz" `
  "5/6"

# Decompress the .gz file
Write-Host ""
Write-Host "[5/6b] Decompressing eng.traineddata.gz..." -ForegroundColor Yellow
try {
  $gzPath  = "$tessdataDir\eng.traineddata.gz"
  $outPath = "$tessdataDir\eng.traineddata"

  $gzStream  = [System.IO.File]::OpenRead((Resolve-Path $gzPath))
  $outStream = [System.IO.File]::Create((Join-Path (Get-Location) $outPath))
  $gzDec     = New-Object System.IO.Compression.GZipStream($gzStream, [System.IO.Compression.CompressionMode]::Decompress)
  $gzDec.CopyTo($outStream)
  $gzDec.Close(); $outStream.Close(); $gzStream.Close()

  Remove-Item $gzPath  # Clean up .gz file
  $size = [math]::Round((Get-Item $outPath).Length / 1MB, 1)
  Write-Host "      Decompressed! (${size}MB)" -ForegroundColor Green
} catch {
  Write-Host "      Decompression failed: $_" -ForegroundColor Red
  Write-Host "      Manually decompress eng.traineddata.gz → eng.traineddata" -ForegroundColor Yellow
}

# ── Download OpenCV.js ────────────────────────────────────────────────────────

Download-File `
  "https://docs.opencv.org/4.9.0/opencv.js" `
  "$libsDir\opencv.js" `
  "6/6"

# ── Final Summary ─────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Download complete! Verifying files..." -ForegroundColor Cyan
Write-Host ""

$requiredFiles = @(
  "$libsDir\tesseract.min.js",
  "$libsDir\tesseract.worker.min.js",
  "$libsDir\tesseract-core.wasm.js",
  "$libsDir\opencv.js",
  "$tessdataDir\eng.traineddata"
)

$allGood = $true
foreach ($file in $requiredFiles) {
  if (Test-Path $file) {
    $size = [math]::Round((Get-Item $file).Length / 1MB, 1)
    Write-Host "  [OK] $file (${size}MB)" -ForegroundColor Green
  } else {
    Write-Host "  [MISSING] $file" -ForegroundColor Red
    $allGood = $false
  }
}

Write-Host ""
if ($allGood) {
  Write-Host "All files present! You can now load the extension in Chrome." -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps:" -ForegroundColor Cyan
  Write-Host "  1. Open Chrome → chrome://extensions/" -ForegroundColor White
  Write-Host "  2. Enable Developer Mode (top-right toggle)" -ForegroundColor White
  Write-Host "  3. Click 'Load unpacked' → select the 'extension/' folder" -ForegroundColor White
  Write-Host "  4. Navigate to https://sp.srmist.edu.in/..." -ForegroundColor White
} else {
  Write-Host "Some files are missing. Check the errors above and re-run." -ForegroundColor Red
}
Write-Host ""
