import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../js/format.js';

test('plain text stays plain', () => {
  assert.equal(renderMarkdown('hello world'), '<p>hello world</p>');
});

test('bold and italic', () => {
  assert.match(renderMarkdown('**big** deal'), /<strong>big<\/strong>/);
  assert.match(renderMarkdown('say *hi* now'), /<em>hi<\/em>/);
  assert.match(renderMarkdown('_under_ score'), /<em>under<\/em>/);
});

test('underline and highlight', () => {
  assert.match(renderMarkdown('__important__ stuff'), /<u>important<\/u>/);
  assert.match(renderMarkdown('==flagged== item'), /<mark>flagged<\/mark>/);
  // no clash with italic single-underscore
  assert.match(renderMarkdown('_soft_ __hard__'), /<em>soft<\/em> <u>hard<\/u>/);
});

test('code spans are escaped and never transformed', () => {
  const html = renderMarkdown('use `**not bold**` here');
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('HTML is escaped first — injection impossible', () => {
  const html = renderMarkdown('<script>alert(1)</script> **x**');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<strong>x<\/strong>/);
});

test('links render with rel/noopener and http-only guard', () => {
  const html = renderMarkdown('[docs](https://example.com/x?a=1&b=2)');
  assert.match(html, /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  // non-http scheme: label only, no anchor
  const evil = renderMarkdown('[x](javascript:alert(1))');
  assert.doesNotMatch(evil, /<a /);
  assert.match(evil, /<p>\[x\]\(javascript:alert\(1\)\)<\/p>/);
});

test('bullet and numbered lists group into ul/ol', () => {
  const html = renderMarkdown('- milk\n- eggs\n\n1. first\n2. second');
  assert.match(html, /<ul><li>milk<\/li><li>eggs<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test('list item content gets inline formatting', () => {
  const html = renderMarkdown('- **bold** item');
  assert.match(html, /<li><strong>bold<\/strong> item<\/li>/);
});

test('empty input', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('mixed: list interrupted by paragraph closes the list', () => {
  const html = renderMarkdown('- a\n\nplain\n\n- b');
  assert.match(html, /<ul><li>a<\/li><\/ul>/);
  assert.match(html, /<p>plain<\/p>/);
  assert.match(html, /<ul><li>b<\/li><\/ul>/);
});
