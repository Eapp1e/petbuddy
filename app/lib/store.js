'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.PETBUDDY_HOME
  ? process.env.PETBUDDY_HOME
  : path.join(os.homedir(), '.petbuddy');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PORT_PATH = path.join(DATA_DIR, 'port');

const DEFAULT_SETTINGS = {
  version: 1,
  appearance: {
    scale: 1.0,          // pet size multiplier 0.5 - 2
    opacity: 1.0,        // 0.3 - 1
    sprite: 'eve',       // eve | blob | custom
    customSpritePath: '',// gif/png shown instead of the CSS sprite
    animationSpeed: 2.0, // pet action animation speed 0 - 2 (2 = original pace)
    bgSpeed: 1.0,        // background ring speed 0.5 - 2
    ringStyle: 'classic', // working-ring style: classic | dual | dash | comet | pulse | dots
    alwaysOnTop: true,
    bubbleEnabled: true, // status speech bubble
    showRing: true,      // background working ring
    showDots: true,      // app indicator dots
  },
  behavior: {
    autoHideWhenNoApp: true, // hide pet while none of the four apps is running
    quitWhenNoApp: false,    // fully quit instead of hiding (checked with delay)
    confirmSound: true,
    notifyEnabled: true,      // Windows 系统通知：完成/出错/待确认
    focusTargetOnApprove: true, // bring target app to front before sending keys
    hideDelaySec: 10,         // grace period after last app closes
    confirmTimeoutSec: 300,   // pending confirm cards expire
    stallSec: 180,            // working with no events this long -> interrupted
    restRemindEnabled: false, // periodic break reminder (needs user ack)
    restRemindMin: 45,        // remind every N minutes
    restSnoozeMin: 5,         // snooze minutes when deferred
  },
  integrations: {
    enabled: { zcode: true, codex: true, workbuddy: true, dsh: true },
    port: 47650,
    nodePath: '', // resolved at install time; empty = auto
  },
  system: {
    autoStart: false,
    startHidden: false,
  },
  window: { x: null, y: null },
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // shallow-merge each section so new keys get defaults
    const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    for (const k of Object.keys(raw || {})) {
      if (out[k] && typeof out[k] === 'object' && typeof raw[k] === 'object') {
        Object.assign(out[k], raw[k]);
      } else {
        out[k] = raw[k];
      }
    }
    return out;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(settings) {
  ensureDataDir();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function writePortFile(port) {
  ensureDataDir();
  try { fs.writeFileSync(PORT_PATH, String(port)); } catch {}
}
function removePortFile() {
  try { fs.unlinkSync(PORT_PATH); } catch {}
}

module.exports = {
  DATA_DIR, CONFIG_PATH, PORT_PATH,
  DEFAULT_SETTINGS, loadSettings, saveSettings,
  writePortFile, removePortFile, ensureDataDir,
};
