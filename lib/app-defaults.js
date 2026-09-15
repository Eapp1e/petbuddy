'use strict';
/**
 * Built-in app registry defaults. Users can extend/override via
 * ~/.petbuddy/apps.config.json (same shape). See README "添加新应用".
 *
 * integration = array of steps the installer performs:
 *   { style: 'zcode-config' }                                  -> ~/.zcode/cli/config.json hooks
 *   { style: 'claude-file', path, eventCase, standalone }      -> Claude-format hooks (standalone file
 *                                                                 or "hooks" key merged into a file)
 *   { style: 'codex-notify' }                                  -> wrap notify in ~/.codex/config.toml
 *   { style: 'dsh-patch' }                                     -> mount dsh-hooks-claude-code
 *   { style: 'none' }                                          -> mirror-only via /api/event
 * eventCase: 'pascal' (SessionStart) | 'kebab' (session-start)
 */
const path = require('path');

const ICONS = path.join(__dirname, '..', 'assets', 'appicons');

module.exports = {
  version: 1,
  apps: [
    {
      id: 'zcode',
      name: 'ZCode',
      // pure black tone (icon glyph is charcoal-black) — maximum contrast
      // against the white codex dot next to it
      color: '#17181c',
      emoji: '🤖',
      icon: path.join(ICONS, 'zcode.png'),
      processNames: ['ZCode.exe'],
      ports: [],
      keys: { approve: '{ENTER}', deny: '{ESC}' },
      integration: [{ style: 'zcode-config' }],
    },
    {
      id: 'codex',
      name: 'Codex',
      // white tone (the icon reads as a white glyph on dark) — pairs with the
      // black zcode dot for an unmistakable difference
      color: '#eef0f4',
      emoji: '🦉',
      icon: path.join(ICONS, 'codex.png'),
      processNames: ['ChatGPT.exe', 'codex.exe'],
      ports: [],
      keys: { approve: '{ENTER}', deny: '{ESC}' },
      integration: [
        { style: 'claude-file', path: '~/.codex/hooks.json', eventCase: 'kebab', standalone: true },
        { style: 'codex-notify' },
      ],
    },
    {
      id: 'workbuddy',
      name: 'WorkBuddy',
      color: '#57d9b5', // dominant color of the app icon (mint)
      emoji: '🐝',
      icon: path.join(ICONS, 'workbuddy.png'),
      processNames: ['WorkBuddy.exe'],
      ports: [],
      keys: { approve: '{ENTER}', deny: '{ESC}' },
      // WorkBuddy's agent CLI (CodeBuddy Code) reads ~/.codebuddy/settings.json
      // and runs hook commands through Git Bash — the shim path is forwarded
      // the desktop app and its bundled CLI may read different settings files —
      // write hooks into both, whichever runtime loads them will fire
      integration: [
        { style: 'workbuddy-legacy-clean' },
        { style: 'claude-file', path: '~/.workbuddy/settings.json', eventCase: 'pascal', standalone: false },
        { style: 'claude-file', path: '~/.codebuddy/settings.json', eventCase: 'pascal', standalone: false },
      ],
    },
    {
      id: 'dsh',
      name: 'DSH',
      color: '#4d6dFF',
      emoji: '🐋',
      icon: path.join(ICONS, 'dsh.svg'),
      processNames: [],
      ports: [3080],
      keys: { approve: '', deny: '' },
      integration: [{ style: 'dsh-patch', eventCase: 'pascal' }],
    },
  ],
};
