/**
 * preprocessor.js — Advanced OpenCV.js Pipeline
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * A highly robust, production-grade image processing pipeline designed specifically
 * for noisy text CAPTCHAs.
 *
 * NEW PIPELINE ORDER (Optimized for text preservation):
 *   1. Upscale FIRST (preserves edges)
 *   2. Grayscale
 *   3. CLAHE Contrast
 *   4. Gaussian Blur
 *   5. Adaptive Threshold (Inverse)
 *   6. Contour Filtering (Removes thin noise lines, dust, and huge blocks)
 *   7. Morphology Open (Removes leftover thin lines)
 *   8. Border Padding (Helps Tesseract)
 *   9. Sharpening
 */

'use strict';

const PREPROCESSING_CONFIG = {
  upscaleFactor: 4,

  // ── 1. Contrast ──
  useCLAHE: true,
  claheClipLimit: 2.0,

  // ── 2. Binarization (Adaptive) ──
  adaptiveBlockSize: 15, // Size of local neighborhood. Must be odd.
  adaptiveC: 10,         // Constant subtracted from mean.

  // ── 3. Contour Filtering ──
  filterContours: true,
  minContourArea: 12,    // Remove dust dots smaller than this
  maxContourArea: 1500,  // Remove huge structural lines/boxes larger than this

  // ── 4. Morphology ──
  morphKernelSize: 2,    // 2=Fills gaps. 1=Off.

  // ── 5. Scaling & Sharpening ──
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

      // ── STAGE 2: Upscale FIRST ──────────────────────────────────────────────
      t = performance.now();
      const upscaledSrc = m(new cv.Mat());
      cv.resize(
        srcMat,
        upscaledSrc,
        new cv.Size(
          srcMat.cols * PREPROCESSING_CONFIG.upscaleFactor,
          srcMat.rows * PREPROCESSING_CONFIG.upscaleFactor
        ),
        0,
        0,
        cv.INTER_CUBIC
      );
      timingMs.upscale = Math.round(performance.now() - t);
      this._saveStage(stages, 'upscaled', this._matToCanvas(upscaledSrc));

      // ── STAGE 3: Grayscale & CLAHE ──────────────────────────────────────────
      t = performance.now();
      const grayMat = m(new cv.Mat());
      cv.cvtColor(upscaledSrc, grayMat, cv.COLOR_RGBA2GRAY);

      let contrastMat = grayMat;
      if (PREPROCESSING_CONFIG.useCLAHE) {
        contrastMat = m(new cv.Mat());
        const clahe = m(new cv.CLAHE(PREPROCESSING_CONFIG.claheClipLimit, new cv.Size(8, 8)));
        clahe.apply(grayMat, contrastMat);
      }
      timingMs.contrast = Math.round(performance.now() - t);
      this._saveStage(stages, 'contrast', this._matToCanvas(contrastMat));

      // ── STAGE 4: Gaussian Blur ──────────────────────────────────────────────
      t = performance.now();
      const blurMat = m(new cv.Mat());
      cv.GaussianBlur(contrastMat, blurMat, new cv.Size(3, 3), 0);
      timingMs.blur = Math.round(performance.now() - t);
      this._saveStage(stages, 'blurred', this._matToCanvas(blurMat));

      // ── STAGE 5: Adaptive Threshold (INVERSE) ───────────────────────────────
      // Text becomes white, background becomes black
      t = performance.now();
      const binaryMat = m(new cv.Mat());
      cv.adaptiveThreshold(
        blurMat,
        binaryMat,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        PREPROCESSING_CONFIG.adaptiveBlockSize,
        PREPROCESSING_CONFIG.adaptiveC
      );
      timingMs.threshold = Math.round(performance.now() - t);
      this._saveStage(stages, 'binary', this._matToCanvas(binaryMat));

      // ── STAGE 6: Contour Filtering (Remove thin lines & dots) ───────────────
      t = performance.now();
      let filteredMat = binaryMat;
      
      // We also create a debug Mat to draw boxes around contours
      const debugMat = m(new cv.Mat());
      cv.cvtColor(binaryMat, debugMat, cv.COLOR_GRAY2RGBA);

      if (PREPROCESSING_CONFIG.filterContours) {
        const contours = m(new cv.MatVector());
        const hierarchy = m(new cv.Mat());
        cv.findContours(binaryMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        const goodContoursMat = m(cv.Mat.zeros(binaryMat.rows, binaryMat.cols, cv.CV_8UC1));

        let removedCount = 0;
        for (let i = 0; i < contours.size(); ++i) {
          const contour = contours.get(i);
          const area = cv.contourArea(contour);
          const rect = cv.boundingRect(contour);

          const width = rect.width;
          const height = rect.height;
          const aspectRatio = width / height;

          // Detect long thin lines
          const isThinHorizontal = aspectRatio > 5;
          const isThinVertical = aspectRatio < 0.2;
          // Tiny dust
          const isTinyNoise = area < PREPROCESSING_CONFIG.minContourArea;
          // Huge blocks
          const isHugeBlob = area > PREPROCESSING_CONFIG.maxContourArea;

          const shouldRemove = isThinHorizontal || isThinVertical || isTinyNoise || isHugeBlob;

          if (!shouldRemove) {
            // Keep valid text
            cv.drawContours(goodContoursMat, contours, i, new cv.Scalar(255), -1);
            
            // Draw a green box around kept characters in the debug overlay
            cv.rectangle(
              debugMat,
              new cv.Point(rect.x, rect.y),
              new cv.Point(rect.x + rect.width, rect.y + rect.height),
              new cv.Scalar(0, 255, 0, 255),
              2
            );
          } else {
            // Draw a red box around removed noise in the debug overlay
            cv.rectangle(
              debugMat,
              new cv.Point(rect.x, rect.y),
              new cv.Point(rect.x + rect.width, rect.y + rect.height),
              new cv.Scalar(255, 0, 0, 255),
              2
            );
            removedCount++;
          }
          contour.delete();
        }

        filteredMat = goodContoursMat;
        SRMLogger.debug('Preprocessor', `Contours removed: ${removedCount}`);
      }
      timingMs.contours = Math.round(performance.now() - t);
      this._saveStage(stages, 'contours', this._matToCanvas(filteredMat));
      this._saveStage(stages, 'contours_debug', this._matToCanvas(debugMat));

      // ── STAGE 7: Morphology OPEN ────────────────────────────────────────────
      t = performance.now();
      let processedMat = filteredMat;
      
      if (PREPROCESSING_CONFIG.morphKernelSize > 1) {
        const openedMat = m(new cv.Mat());
        const morphKernel = m(cv.getStructuringElement(
          cv.MORPH_RECT,
          new cv.Size(PREPROCESSING_CONFIG.morphKernelSize, PREPROCESSING_CONFIG.morphKernelSize)
        ));
        cv.morphologyEx(filteredMat, openedMat, cv.MORPH_OPEN, morphKernel);
        processedMat = openedMat;
        this._saveStage(stages, 'morphology', this._matToCanvas(processedMat));
      }
      timingMs.morphology = Math.round(performance.now() - t);

      // ── STAGE 8: Border Padding ─────────────────────────────────────────────
      t = performance.now();
      const paddedMat = m(new cv.Mat());
      cv.copyMakeBorder(
        processedMat,
        paddedMat,
        20, 20, 20, 20, // top, bottom, left, right
        cv.BORDER_CONSTANT,
        new cv.Scalar(0, 0, 0, 255) // black border since background is black now
      );
      processedMat = paddedMat;
      timingMs.padding = Math.round(performance.now() - t);

      // ── STAGE 9: Sharpen & Invert back ──────────────────────────────────────
      t = performance.now();
      let finalMat = processedMat;
      
      if (PREPROCESSING_CONFIG.sharpen) {
        const blurredUp = m(new cv.Mat());
        cv.GaussianBlur(processedMat, blurredUp, new cv.Size(0, 0), 3);
        finalMat = m(new cv.Mat());
        cv.addWeighted(processedMat, 2.0, blurredUp, -1.0, 0, finalMat);
      }

      // Invert back to Black text on White background for Tesseract OCR
      const invertedFinal = m(new cv.Mat());
      cv.bitwise_not(finalMat, invertedFinal);
      finalMat = invertedFinal;

      timingMs.sharpen = Math.round(performance.now() - t);
      this._saveStage(stages, 'final', this._matToCanvas(finalMat));

      // ── EXPORT ──────────────────────────────────────────────────────────────
      const processedBase64 = stages.final; 
      const totalTime = Math.round(performance.now() - pipelineStart);

      return {
        processedBase64,
        originalBase64: base64PNG,
        dimensions: { width: finalMat.cols, height: finalMat.rows },
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
    ['adaptiveBlockSize'].forEach(k => {
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
