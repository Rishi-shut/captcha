# SRM Portal CAPTCHA Solver
### Chrome Extension · Manifest V3 · Tesseract.js OCR · OpenCV.js Preprocessing

[![Status](https://img.shields.io/badge/status-active-brightgreen)](https://github.com)
[![Manifest](https://img.shields.io/badge/manifest-v3-blue)](https://developer.chrome.com/docs/extensions/mv3/)
[![OCR](https://img.shields.io/badge/OCR-Tesseract.js-orange)](https://tesseract.projectnaptha.com/)
[![Vision](https://img.shields.io/badge/Vision-OpenCV.js-red)](https://opencv.org/)
[![License](https://img.shields.io/badge/license-MIT-purple)](LICENSE)

---

> **⚠️ Educational Use Only**  
> This extension was built as an educational project by a student with full authorization to access the SRM student portal. It is designed exclusively for `sp.srmist.edu.in` and cannot be used on any other website.

---

## What Does It Do?

Every time you log in to the SRM student portal, you have to squint at a fuzzy CAPTCHA image and type it manually. This extension **reads the CAPTCHA for you** and fills it in automatically — so you just type your username and password and click Login.

**The entire process runs in your browser. No data is ever sent anywhere.**

```
You open the SRM portal login page
        ↓
Extension detects the CAPTCHA (automatically)
        ↓  
Captures the CAPTCHA image pixels
        ↓
Cleans the image (removes noise, enhances contrast)
        ↓
Reads the text using OCR (Tesseract.js)
        ↓
Types the answer into the CAPTCHA field ✓
```

---

## Features

| Feature | Status |
|---|---|
| 🔍 Automatic CAPTCHA detection | ✅ Implemented |
| 🖼️ Image preprocessing pipeline (OpenCV.js) | ✅ Implemented |
| 🔤 OCR with Tesseract.js | ✅ Implemented |
| ✏️ Auto-fill CAPTCHA field | ✅ Implemented |
| 🔄 Auto-retry on low confidence | ✅ Implemented |
| 👁️ Live CAPTCHA preview in popup | ✅ Implemented |
| 📊 OCR confidence score display | ✅ Implemented |
| 🔧 Manual correction override | ✅ Implemented |
| 🐛 Debug mode with logs | ✅ Implemented |
| 📈 Statistics tracking | ✅ Implemented |
| 🌙 Dark mode popup | ✅ Implemented |
| ⚙️ Auto-submit toggle | ✅ Implemented (default: OFF) |
| 🎯 Domain-locked to SRM portal | ✅ By design |

---

## Screenshots

> *Extension popup showing CAPTCHA preview, confidence score, and controls*

```
┌─────────────────────────────────────┐
│  🎯 SRM CAPTCHA Solver         ⚙️  │
│  ●  Enabled                         │
│─────────────────────────────────────│
│  Status: ✅ Solved — 87% confidence │
│─────────────────────────────────────│
│  Original          Processed        │
│  ┌──────────┐      ┌──────────┐     │
│  │ AB3D (blurry)│  │ AB3D (clean)│  │
│  └──────────┘      └──────────┘     │
│─────────────────────────────────────│
│  Confidence: ████████░░  87%        │
│─────────────────────────────────────│
│  Attempts: 12  Successes: 10  82%   │
│─────────────────────────────────────│
│  [ Retry ] [ Manual Correction... ] │
└─────────────────────────────────────┘
```

---

## Architecture Overview

```
SRM Portal Page
    │
    ▼ (Content Scripts)
captchaDetector.js → finds CAPTCHA image + input field
imageCapture.js    → copies CAPTCHA pixels to canvas
preprocessor.js    → OpenCV.js cleaning pipeline
ocrEngine.js       → Tesseract.js reads the text
autofill.js        → fills the CAPTCHA field
    │
    ▼ (Messages)
background.js      → stores state, routes messages
    │
    ▼ (Popup)
popup.html/js/css  → dark UI with all controls + previews
```

Full architecture details: [`docs/architecture.md`](docs/architecture.md)

---

## Quick Setup

### Prerequisites
- Google Chrome (v88+)
- The large library files (see below)

### 1. Get the code
```bash
git clone https://github.com/YOUR_USERNAME/srm-captcha-solver.git
```

### 2. Download libraries (required, not in repo due to size)

**Windows (PowerShell):**
```powershell
# Run from project root
$libs = "extension\libs"
New-Item -ItemType Directory -Force -Path "$libs\tessdata"

Invoke-WebRequest "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js" -OutFile "$libs\tesseract.min.js"
Invoke-WebRequest "https://unpkg.com/tesseract.js@5/dist/worker.min.js"    -OutFile "$libs\tesseract.worker.min.js"
Invoke-WebRequest "https://unpkg.com/tesseract.js-core@5/tesseract-core-simd.wasm.js" -OutFile "$libs\tesseract-core.wasm.js"
Invoke-WebRequest "https://docs.opencv.org/4.9.0/opencv.js"                -OutFile "$libs\opencv.js"
```

> Also download `eng.traineddata` from [naptha/tessdata](https://github.com/naptha/tessdata) → place in `extension/libs/tessdata/`

### 3. Load in Chrome
1. Go to `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `extension/` folder

### 4. Use it
Navigate to the SRM portal — CAPTCHA will auto-fill within 2–4 seconds.

Full setup guide: [`docs/setup-guide.md`](docs/setup-guide.md)

---

## Technology Stack

| Technology | Purpose | Why |
|---|---|---|
| **Chrome Extension MV3** | Extension framework | Current Chrome standard |
| **JavaScript (Vanilla)** | All logic | No build step needed |
| **Tesseract.js v5** | OCR engine | Best JS OCR, runs in-browser |
| **OpenCV.js 4.x** | Image preprocessing | Industry-standard computer vision |
| **chrome.storage.local** | Settings/stats persistence | Extension-safe storage |
| **MutationObserver** | CAPTCHA refresh detection | Browser-native DOM watching |
| **Web Workers** | OCR threading | Non-blocking OCR execution |

---

## Project Structure

```
captcha/
├── .gitignore
├── package.json
├── README.md
├── docs/                    ← Detailed documentation (gitignored)
│   ├── architecture.md
│   ├── captcha-flow.md
│   ├── preprocessing.md
│   ├── OCR.md
│   ├── testing.md
│   ├── debugging.md
│   ├── limitations.md
│   ├── setup-guide.md
│   └── future-improvements.md
├── extension/               ← The Chrome extension (load this folder)
│   ├── manifest.json
│   ├── background/
│   ├── content/
│   ├── preprocessing/
│   ├── utils/
│   ├── popup/
│   ├── assets/
│   └── libs/               ← Download separately (gitignored)
└── test-captchas/
    └── test-runner.html     ← Offline OCR testing tool
```

---

## Documentation

All documentation is in the `docs/` folder (local only, gitignored):

| Document | What it covers |
|---|---|
| [`architecture.md`](docs/architecture.md) | Extension structure, contexts, data flow |
| [`captcha-flow.md`](docs/captcha-flow.md) | Step-by-step pipeline, timing, error states |
| [`preprocessing.md`](docs/preprocessing.md) | OpenCV.js pipeline, each step explained |
| [`OCR.md`](docs/OCR.md) | Tesseract.js, PSM modes, confidence scores |
| [`testing.md`](docs/testing.md) | How to test, accuracy measurement |
| [`debugging.md`](docs/debugging.md) | DevTools, common errors, debug mode |
| [`limitations.md`](docs/limitations.md) | What doesn't work, ethical considerations |
| [`setup-guide.md`](docs/setup-guide.md) | Installation, library downloads |
| [`future-improvements.md`](docs/future-improvements.md) | Planned enhancements, roadmap |

---

## How OCR Works (Simple Explanation)

1. **Capture:** The CAPTCHA image is drawn onto an invisible canvas — this gives us access to its pixels
2. **Grayscale:** Convert colour → shades of grey (simpler for OCR)
3. **Denoise:** Gaussian blur smooths out random noise pixels
4. **Threshold:** Convert grey → pure black/white (text is black, background is white)
5. **Morphology:** Fill gaps that noise lines cut into characters
6. **Upscale:** Make the image 3× bigger (Tesseract works better on larger images)
7. **OCR:** Tesseract analyses pixel patterns and returns text + confidence score
8. **Fill:** The text is typed into the CAPTCHA field

---

## Accuracy

Expected accuracy on SRM's CAPTCHA (after preprocessing):

| Condition | Expected accuracy |
|---|---|
| Normal CAPTCHA, good conditions | 75–90% |
| Heavy noise lines | 60–75% |
| Extremely distorted | 40–60% |

The retry logic (up to 3 attempts) significantly improves the effective success rate. With 3 attempts and 80% per-attempt accuracy: 1 - (0.2³) = **99.2% effective success rate**.

---

## Future Roadmap

### Version 1.1
- [ ] Login success/failure detection for smarter retry
- [ ] Adaptive thresholding (handles uneven CAPTCHA backgrounds)
- [ ] Horizontal noise line removal
- [ ] Per-character confidence analysis

### Version 1.2
- [ ] Preprocessing visualiser in popup (all stages)
- [ ] Advanced settings panel (tune preprocessing parameters)
- [ ] OCR confidence history chart

### Version 2.0
- [ ] Firefox support
- [ ] Automatic selector recovery (if portal HTML changes)
- [ ] CAPTCHA session expiry detection

---

## Educational Disclaimer

This project was created for educational purposes to demonstrate:
- Chrome Extension development with Manifest V3
- Browser-based OCR using Tesseract.js
- Computer vision preprocessing with OpenCV.js
- Content script and service worker architecture

**This extension:**
- ✅ Only works on `sp.srmist.edu.in`
- ✅ Processes everything locally (no external APIs)
- ✅ Does not store passwords or personal data
- ✅ Does not perform any unauthorized actions
- ❌ Is NOT designed to bypass security on other websites
- ❌ Is NOT a universal CAPTCHA solving tool

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

*Built with ❤️ for SRM students who just want to log in without the hassle.*