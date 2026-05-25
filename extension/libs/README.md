# extension/libs/ — External Libraries

This folder contains the large binary library files required by the extension.

## ⚠️ These files are NOT in git (see .gitignore)

They are too large for a git repository (~16MB total). You must download them before the extension will work.

## Quick Download (Windows PowerShell)

From the project root:
```powershell
.\scripts\download-libs.ps1
```

## Manual Download

| File | Source | Size |
|---|---|---|
| `tesseract.min.js` | https://unpkg.com/tesseract.js@5/dist/tesseract.min.js | ~1MB |
| `tesseract.worker.min.js` | https://unpkg.com/tesseract.js@5/dist/worker.min.js | ~0.5MB |
| `tesseract-core.wasm.js` | https://unpkg.com/tesseract.js-core@5/tesseract-core-simd.wasm.js | ~3MB |
| `tessdata/eng.traineddata` | https://github.com/naptha/tessdata (gh-pages/4.0.0/) | ~4MB |
| `opencv.js` | https://docs.opencv.org/4.9.0/opencv.js | ~8MB |

## Required Folder Structure

```
libs/
├── opencv.js
├── tesseract.min.js
├── tesseract.worker.min.js
├── tesseract-core.wasm.js
└── tessdata/
    └── eng.traineddata
```

See `docs/setup-guide.md` for full instructions.
