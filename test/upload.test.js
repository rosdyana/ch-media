const { test } = require('node:test');
const assert = require('node:assert');
const { assertAllowedFile } = require('../src/upload');

test('assertAllowedFile accepts an allowed extension with a matching mimetype', () => {
  assert.doesNotThrow(() => assertAllowedFile('song.mp3', 'audio/mpeg'));
});

test('assertAllowedFile rejects a disallowed extension with 415', () => {
  assert.throws(
    () => assertAllowedFile('malware.exe', 'application/octet-stream'),
    (err) => err.statusCode === 415,
  );
});

test('assertAllowedFile accepts a generic/missing mimetype when the extension is allowed', () => {
  assert.doesNotThrow(() => assertAllowedFile('song.mp3', 'application/octet-stream'));
  assert.doesNotThrow(() => assertAllowedFile('song.mp3', ''));
});

test('assertAllowedFile rejects an allowed extension paired with a clearly wrong mimetype', () => {
  assert.throws(
    () => assertAllowedFile('song.mp3', 'image/png'),
    (err) => err.statusCode === 415,
  );
});
