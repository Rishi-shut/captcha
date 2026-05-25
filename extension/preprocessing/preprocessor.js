/**
 * preprocessor.js — Advanced OpenCV.js Pipeline
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * A highly robust, production-grade image processing pipeline designed specifically
 * for noisy text CAPTCHAs. Converts raw noisy images into clean, crisp, high-contrast
 * binary images that Tesseract can read flawlessly.
 *
 * NEW ARCHITECTURE:
 *   1. Grayscale
 *   2. Contrast Enhancement (CLAHE) — normalizes uneven lighting
 *   3. Median Blur — destroys salt-and-pepper noise while preserving hard edges
 *   4. Adaptive Thresholding — calculates binarization locally, ignoring shadows
 *   5. Contour Filtering — measures every black blob; erases dust dots and huge blocks
 *   6. Morphology — closes gaps inside characters cut by noise lines
 *   7. Upscale (Bicubic) — enlarges to Tesseract's optimal font size
 *   8. Unsharp Masking — crispifies the upscaled edges
 */

'use strict';

const PREPROCESSING_CONFIG = {
  // ── 1. Contrast ──
  useCLAHE: true,
  claheClipLimit: 2.0,

  // ── 2. Denoise ──
  medianBlurKernel: 3, // Must be odd (1, 3, 5). Excellent for removing dots without edge blur.

  // ── 3. Binarization (Adaptive) ──
  adaptiveBlockSize: 15, // Size of local neighborhood. Must be odd.
  adaptiveC: 10,         // Constant subtracted from mean. Higher = less noise but thinner text.

  // ── 4. Contour Filtering ──
  filterContours: true,
  minContourArea: 10,    // Remove dust dots smaller than this
  maxContourArea: 2000,  // Remove huge structural lines/boxes larger than this

  // ── 5. Morphology ──
  morphKernelSize: 2,    // 2=Fills gaps. 1=Off.
  thinKernelSize: 1,     // Dilation to separate overlapping text. 1=Off.

  // ── 6. Scaling & Sharpening ──
  upscaleFactor: 3,
  sharpen: true,
};

const SRMPreprocessor = {
  _opencvReady: false,

  async waitForOpenCV(timeoutMs = 10000) {
    if (this._opencvReady) return;
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        if (typeof cv !== 'undefined' && cv.Mat) {
          this._opencvReady = true;
          SRMLogger.info('Preprocessor', 'OpenCV.js ready ✓');
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error('OpenCV.js failed to load'));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  },

  async process(base64PNG) {
    SRMLogger.info('Preprocessor', 'Starting advanced pipeline...');
    const pipelineStart = performance.now();
    await this.waitForOpenCV();

    const timingMs = {};
    const stages = {};
    const matsToDelete = [];

    // Helper to safely allocate and track Mats
    const m = (mat) => {
      matsToDelete.push(mat);
      return mat;
    };

    try {
      // ── STAGE 1: Load ───────────────────────────────────────────────────────
      let t = performance.now();
      const { canvas } = await this._base64ToCanvas(base64PNG);
      const srcMat = m(cv.imread(canvas));
      timingMs.load = Math.round(performance.now() - t);
      this._saveStage(stages, 'original', canvas);

      // ── STAGE 2: Grayscale & CLAHE ──────────────────────────────────────────
      t = performance.now();
      const grayMat = m(new cv.Mat());
      cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);

      let contrastMat = grayMat;
      if (PREPROCESSING_CONFIG.useCLAHE) {
        contrastMat = m(new cv.Mat());
        const clahe = m(new cv.CLAHE(PREPROCESSING_CONFIG.claheClipLimit, new cv.Size(8, 8)));
        clahe.apply(grayMat, contrastMat);
      }
      timingMs.contrast = Math.round(performance.now() - t);
      this._saveStage(stages, 'contrast', this._matToCanvas(contrastMat));

      // ── STAGE 3: Median Blur ────────────────────────────────────────────────
      t = performance.now();
      let blurMat = contrastMat;
      if (PREPROCESSING_CONFIG.medianBlurKernel > 1) {
        blurMat = m(new cv.Mat());
        cv.medianBlur(contrastMat, blurMat, PREPROCESSING_CONFIG.medianBlurKernel);
      }
      timingMs.blur = Math.round(performance.now() - t);
      this._saveStage(stages, 'blurred', this._matToCanvas(blurMat));

      // ── STAGE 4: Adaptive Thresholding ──────────────────────────────────────
      t = performance.now();
      const binaryMat = m(new cv.Mat());
      cv.adaptiveThreshold(
        blurMat,
        binaryMat,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        PREPROCESSING_CONFIG.adaptiveBlockSize,
        PREPROCESSING_CONFIG.adaptiveC
      );
      timingMs.threshold = Math.round(performance.now() - t);
      this._saveStage(stages, 'binary', this._matToCanvas(binaryMat));

      // ── STAGE 5: Contour Filtering (Destroy Noise) ──────────────────────────
      t = performance.now();
      let filteredMat = binaryMat;
      if (PREPROCESSING_CONFIG.filterContours) {
        // Find contours works on WHITE foreground on BLACK background.
        // Our text is currently BLACK on WHITE background. We must invert first.
        const invertedMat = m(new cv.Mat());
        cv.bitwise_not(binaryMat, invertedMat);

        const contours = m(new cv.MatVector());
        const hierarchy = m(new cv.Mat());
        cv.findContours(invertedMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // Create a blank black canvas to draw the good contours onto
        const goodContoursMat = m(cv.Mat.zeros(invertedMat.rows, invertedMat.cols, cv.CV_8UC1));

        let removedCount = 0;
        for (let i = 0; i < contours.size(); ++i) {
          const contour = contours.get(i);
          const area = cv.contourArea(contour);
          
          // Only draw contours that are within our valid text size limits
          if (area >= PREPROCESSING_CONFIG.minContourArea && area <= PREPROCESSING_CONFIG.maxContourArea) {
            // Draw filled contour in white
            cv.drawContours(goodContoursMat, contours, i, new cv.Scalar(255), -1, cv.LINE_8, hierarchy, 0);
          } else {
            removedCount++;
          }
          contour.delete(); // VERY IMPORTANT: contours.get() returns a new Mat wrapper
        }

        // Invert back to Black text on White background for Tesseract
        filteredMat = m(new cv.Mat());
        cv.bitwise_not(goodContoursMat, filteredMat);
        
        SRMLogger.debug('Preprocessor', `Contours removed: ${removedCount}`);
      }
      timingMs.contours = Math.round(performance.now() - t);
      this._saveStage(stages, 'contours', this._matToCanvas(filteredMat));

      // ── STAGE 6: Morphology & Thinning ──────────────────────────────────────
      t = performance.now();
      let processedMat = filteredMat;
      
      // Thinning (Dilation)
      if (PREPROCESSING_CONFIG.thinKernelSize > 1) {
        const thinnedMat = m(new cv.Mat());
        const tk = m(cv.Mat.ones(PREPROCESSING_CONFIG.thinKernelSize, PREPROCESSING_CONFIG.thinKernelSize, cv.CV_8U));
        cv.dilate(processedMat, thinnedMat, tk);
        processedMat = thinnedMat;
        this._saveStage(stages, 'thinned', this._matToCanvas(processedMat));
      }

      // Closing
      if (PREPROCESSING_CONFIG.morphKernelSize > 1) {
        const closedMat = m(new cv.Mat());
        const mk = m(cv.Mat.ones(PREPROCESSING_CONFIG.morphKernelSize, PREPROCESSING_CONFIG.morphKernelSize, cv.CV_8U));
        cv.morphologyEx(processedMat, closedMat, cv.MORPH_CLOSE, mk);
        processedMat = closedMat;
        this._saveStage(stages, 'morphology', this._matToCanvas(processedMat));
      }
      timingMs.morphology = Math.round(performance.now() - t);

      // ── STAGE 7: Upscale & Sharpen ──────────────────────────────────────────
      t = performance.now();
      const upscaledMat = m(new cv.Mat());
      const newSize = new cv.Size(
        processedMat.cols * PREPROCESSING_CONFIG.upscaleFactor,
        processedMat.rows * PREPROCESSING_CONFIG.upscaleFactor
      );
      cv.resize(processedMat, upscaledMat, newSize, 0, 0, cv.INTER_CUBIC);

      let finalMat = upscaledMat;
      if (PREPROCESSING_CONFIG.sharpen) {
        // Unsharp Mask: original*(1.5) - blurred*(0.5)
        const blurredUp = m(new cv.Mat());
        cv.GaussianBlur(upscaledMat, blurredUp, new cv.Size(0, 0), 3);
        finalMat = m(new cv.Mat());
        cv.addWeighted(upscaledMat, 1.5, blurredUp, -0.5, 0, finalMat);
      }
      timingMs.upscale = Math.round(performance.now() - t);
      this._saveStage(stages, 'final', this._matToCanvas(finalMat));

      // ── EXPORT ──────────────────────────────────────────────────────────────
      const processedBase64 = stages.final; // already converted
      const totalTime = Math.round(performance.now() - pipelineStart);

      return {
        processedBase64,
        originalBase64: base64PNG,
        dimensions: { width: newSize.width, height: newSize.height },
        stages,
        timingMs,
        totalTimeMs: totalTime,
      };

    } finally {
      // ── CRITICAL: OpenCV WASM Memory Cleanup ──
      for (const mat of matsToDelete) {
        try {
          if (mat && !mat.isDeleted()) mat.delete();
        } catch (e) { /* ignore */ }
      }
    }
  },

  _base64ToCanvas(base64PNG) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve({ canvas, img });
      };
      img.onerror = reject;
      img.src = base64PNG;
    });
  },

  _matToCanvas(mat) {
    const canvas = document.createElement('canvas');
    canvas.width = mat.cols; canvas.height = mat.rows;
    cv.imshow(canvas, mat);
    return canvas;
  },

  _saveStage(stages, name, canvasOrBase64) {
    if (typeof canvasOrBase64 === 'string') {
      stages[name] = canvasOrBase64;
    } else if (canvasOrBase64 && canvasOrBase64.toDataURL) {
      stages[name] = canvasOrBase64.toDataURL('image/png');
    }
  },

  configure(options = {}) {
    Object.assign(PREPROCESSING_CONFIG, options);
    // Ensure odd numbers for kernels
    ['medianBlurKernel', 'adaptiveBlockSize'].forEach(k => {
      if (PREPROCESSING_CONFIG[k] !== undefined && PREPROCESSING_CONFIG[k] % 2 === 0) {
        PREPROCESSING_CONFIG[k] += 1;
      }
    });
    SRMLogger.info('Preprocessor', 'Configured:', PREPROCESSING_CONFIG);
  },

  getConfig() {
    return { ...PREPROCESSING_CONFIG };
  }
};

window.SRMPreprocessor = SRMPreprocessor;
