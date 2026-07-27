const { test } = require('node:test');
const assert = require('node:assert');
const { parseJson3, pickBestCaption } = require('../src/youtube');

test('parseJson3 joins segments and skips newline-only events', () => {
  const json = JSON.stringify({
    events: [
      { segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { segs: [{ utf8: '\n' }] },
      { segs: [{ utf8: 'second line' }] },
    ],
  });
  assert.strictEqual(parseJson3(json), 'Hello world second line');
});

test('parseJson3 returns empty string on malformed json', () => {
  assert.strictEqual(parseJson3('not json'), '');
});

test('pickBestCaption respects SUB_LANGS preference (en before ja by default)', () => {
  const best = pickBestCaption([
    { lang: 'ja', file: 'a' },
    { lang: 'en', file: 'b' },
  ]);
  assert.strictEqual(best.file, 'b');
});
