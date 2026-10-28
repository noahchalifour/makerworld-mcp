import { describe, it, expect } from 'vitest';
import { parseModelRef, htmlToText } from '../src/parse.js';
import { MakerWorldError } from '../src/errors.js';

describe('parseModelRef', () => {
  it('accepts a bare id', () => {
    expect(parseModelRef('1400000')).toEqual({ id: 1400000 });
    expect(parseModelRef(' 22424 ')).toEqual({ id: 22424 });
  });
  it('accepts a model URL with slug and locale', () => {
    expect(parseModelRef('https://makerworld.com/en/models/1400000-honkai-star-rail')).toEqual({ id: 1400000 });
    expect(parseModelRef('https://makerworld.com/models/22424')).toEqual({ id: 22424 });
  });
  it('reads a profile id from the URL hash', () => {
    expect(parseModelRef('https://makerworld.com/en/models/1400000-x#profileId-1451665')).toEqual({ id: 1400000, profileId: 1451665 });
  });
  it('rejects anything else with INVALID_INPUT', () => {
    for (const bad of ['', 'benchy', 'https://example.com/models/1', 'https://makerworld.com/en/u/someone']) {
      expect(() => parseModelRef(bad)).toThrow(MakerWorldError);
      try { parseModelRef(bad); } catch (e) { expect((e as MakerWorldError).code).toBe('INVALID_INPUT'); }
    }
  });
});

describe('htmlToText', () => {
  it('converts paragraphs, breaks, lists and entities', () => {
    const html = '<p>Hi hi,</p><p>&nbsp;</p><p>Line&#39;s <b>bold</b> &amp; more<br>next</p><ul><li>one</li><li>two</li></ul>';
    expect(htmlToText(html)).toBe("Hi hi,\n\nLine's bold & more\nnext\n- one\n- two");
  });
  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});
