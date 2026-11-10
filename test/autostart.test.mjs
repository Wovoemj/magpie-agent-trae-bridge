import assert from 'node:assert/strict';
import test from 'node:test';

const { scriptEncoding, scriptText } = await import('../lib/autostart.js');

test('windows autostart script carries a UTF-16 LE BOM', () => {
  // wscript reads a .vbs with the ANSI code page until it sees the BOM; a
  // non-ASCII install path (D:\DSH\会话内容\...) would be mojibake without it.
  assert.equal(scriptEncoding('win32'), 'utf16le');
  const body = 'CreateObject("WScript.Shell").Run """C:\\nvm4w\\nodejs\\node.exe""", 0, False';
  const out = scriptText(body, 'win32');
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.slice(1), body);
});

test('posix autostart scripts stay plain utf8 without a BOM', () => {
  assert.equal(scriptEncoding('linux'), 'utf8');
  assert.equal(scriptEncoding('darwin'), 'utf8');
  assert.equal(scriptText('<plist/>', 'darwin'), '<plist/>');
  assert.equal(scriptText('<plist/>', 'linux'), '<plist/>');
});
