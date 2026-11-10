import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, home } from './util.js';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(HERE, 'bin', 'trae-magpie.js');

/** Start the catalog daemon in the background the same way the Cursor bridge does. */
export function autostartPath() {
  const h = home();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'magpie-trae-bridge.vbs');
  }
  if (process.platform === 'darwin') {
    return path.join(h, 'Library', 'LaunchAgents', 'com.magpie.trae-bridge.plist');
  }
  return path.join(h, '.config', 'systemd', 'user', 'magpie-trae-bridge.service');
}

function payload(port) {
  const node = process.execPath;
  if (process.platform === 'win32') {
    const quote = (s) => `"${s.replace(/"/g, '""')}"`;
    return `' magpie-trae-bridge — hidden catalog daemon\nCreateObject("WScript.Shell").Run ${quote(
      `${quote(node)} ${quote(CLI)} serve --port ${port}`,
    )}, 0, False\n`;
  }
  if (process.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.magpie.trae-bridge</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${CLI}</string><string>serve</string><string>--port</string><string>${port}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${path.join(home(), '.config', 'magpie-trae-bridge', 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(home(), '.config', 'magpie-trae-bridge', 'daemon.log')}</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=magpie-trae-bridge catalog daemon
After=network.target

[Service]
ExecStart=${node} ${CLI} serve --port ${port}
Restart=no

[Install]
WantedBy=default.target
`;
}

/**
 * Windows Script Host parses a .vbs with the ANSI code page unless the file opens
 * with a UTF-16 LE BOM.  The payload embeds the absolute CLI path, which may be
 * non-ASCII (here: D:\DSH\会话内容\...), so without the BOM wscript hands node a
 * mojibake path, the hidden Run dies instantly and the daemon never comes up —
 * with no error written anywhere.
 */
export function scriptText(text, platform = process.platform) {
  return platform === 'win32' ? `\uFEFF${text}` : text;
}

export function scriptEncoding(platform = process.platform) {
  return platform === 'win32' ? 'utf16le' : 'utf8';
}

export async function enable(port) {
  const file = autostartPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, scriptText(payload(port)), scriptEncoding());
  return file;
}

export async function disable() {
  const file = autostartPath();
  if (!exists(file)) return { removed: false, file };
  await fsp.rm(file, { force: true });
  return { removed: true, file };
}

export function status() {
  const file = autostartPath();
  return { file, enabled: exists(file) };
}
