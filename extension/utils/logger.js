/**
 * logger.js — Centralized Logging Utility
 *
 * WHY: All modules in the extension need consistent, leveled logging.
 * Instead of scattered console.log calls, we centralise here so:
 *   - Debug logs can be toggled off in production.
 *   - Logs are stored in session storage so the popup can read them.
 *   - Each log entry is timestamped and tagged with a module name.
 *
 * LOG LEVELS (in order of severity):
 *   DEBUG  → verbose detail, only shown in debug mode
 *   INFO   → normal operation milestones
 *   WARN   → unexpected but recoverable situation
 *   ERROR  → failure that needs attention
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_LEVELS = {
  DEBUG: 0,
  INFO:  1,
  WARN:  2,
  ERROR: 3,
};

/** Maximum number of log entries kept in memory and storage. */
const MAX_LOG_ENTRIES = 200;

/** Current log level — can be overridden at runtime via SRMLogger.setLevel() */
let currentLevel = LOG_LEVELS.INFO;

/** In-memory circular buffer of recent log entries */
const logBuffer = [];

/** Whether to also persist logs to chrome.storage.session */
let persistLogs = false;

// ─── Core Logger Object ───────────────────────────────────────────────────────

const SRMLogger = {

  /**
   * Configure the logger.
   * @param {object} options
   * @param {boolean} options.debugMode  - If true, show DEBUG level logs
   * @param {boolean} options.persist    - If true, save logs to storage for popup
   */
  configure({ debugMode = false, persist = false } = {}) {
    currentLevel = debugMode ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;
    persistLogs  = persist;
    this.info('Logger', `Logger configured — level=${debugMode ? 'DEBUG' : 'INFO'}, persist=${persist}`);
  },

  /**
   * Log a DEBUG message — only visible when debugMode is on.
   * @param {string} module - Which module is logging (e.g. 'Preprocessor')
   * @param {string} message
   * @param {*}      [data] - Optional extra data to log
   */
  debug(module, message, data) {
    this._log(LOG_LEVELS.DEBUG, 'DEBUG', module, message, data);
  },

  /** Log an INFO message — normal operation. */
  info(module, message, data) {
    this._log(LOG_LEVELS.INFO, 'INFO', module, message, data);
  },

  /** Log a WARN message — unexpected but not fatal. */
  warn(module, message, data) {
    this._log(LOG_LEVELS.WARN, 'WARN', module, message, data);
  },

  /** Log an ERROR message — something failed. */
  error(module, message, data) {
    this._log(LOG_LEVELS.ERROR, 'ERROR', module, message, data);
  },

  /**
   * Internal log implementation.
   * @private
   */
  _log(level, levelName, module, message, data) {
    if (level < currentLevel) return; // Skip logs below current level

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level: levelName,
      module,
      message,
      data: data !== undefined ? String(data) : undefined,
    };

    // Pretty-print to browser console with colour coding
    const prefix  = `[SRM][${levelName}][${module}]`;
    const style   = this._getStyle(levelName);
    if (data !== undefined) {
      console.groupCollapsed(`%c${prefix} ${message}`, style);
      console.log(data);
      console.groupEnd();
    } else {
      console.log(`%c${prefix} ${message}`, style);
    }

    // Add to in-memory buffer (trim if too large)
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer.shift(); // Remove oldest entry
    }

    // Persist to chrome.storage.local if enabled (for popup to read)
    if (persistLogs && typeof chrome !== 'undefined' && chrome.storage) {
      // Fire-and-forget — we don't block on storage write
      chrome.storage.local.set({ srmLogs: [...logBuffer] }).catch(() => {
        // Silently ignore
      });
    }
  },

  /**
   * Returns the in-memory log buffer as an array of entries.
   * @returns {Array<object>}
   */
  getLogs() {
    return [...logBuffer];
  },

  /**
   * Clears the in-memory log buffer.
   */
  clearLogs() {
    logBuffer.length = 0;
    if (persistLogs && typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ srmLogs: [] }).catch(() => {});
    }
  },

  /**
   * CSS styles for different log levels in the console.
   * @private
   */
  _getStyle(levelName) {
    const styles = {
      DEBUG: 'color: #9e9e9e; font-weight: normal;',
      INFO:  'color: #4fc3f7; font-weight: bold;',
      WARN:  'color: #ffb74d; font-weight: bold;',
      ERROR: 'color: #ef5350; font-weight: bold;',
    };
    return styles[levelName] || '';
  },
};

// Make available globally within the content script context
window.SRMLogger = SRMLogger;
