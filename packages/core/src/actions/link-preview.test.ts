import { describe, expect, it } from 'vitest';
import { headDone, isFetchableAddress, parseOpenGraph } from './link-preview';

describe('isFetchableAddress (decision 84)', () => {
  it('allows public http(s) pages only', () => {
    expect(isFetchableAddress('https://acme.example.com/blog/design-reviews')).toBe(true);
    expect(isFetchableAddress('http://docs.example.com/d/1')).toBe(true);
    expect(isFetchableAddress('https://93.184.216.34/')).toBe(true);
  });

  it('never fetches this computer, the local network, or odd schemes', () => {
    for (const a of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://192.168.1.1/admin',
      'http://10.0.0.5/',
      'http://172.20.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://[fd12::1]/',
      'http://intranet/wiki',
      'https://printer.local/',
      'https://wiki.corp/',
      'file:///C:/pages/a.html',
      'ftp://files.example.com/',
      'https://user:pass@acme.example.com/',
      'not a url',
      null,
    ]) {
      expect(isFetchableAddress(a), String(a)).toBe(false);
    }
  });
});

describe('parseOpenGraph (decision 84)', () => {
  it('reads Open Graph first, in either attribute order, with entities decoded and the image made absolute', () => {
    const html = `<html><head>
      <title>Ignored title</title>
      <meta content="How we run design reviews" property="og:title">
      <meta property="og:description" content="Who comes, what to bring, &amp; how decisions get written down.">
      <meta property='og:site_name' content='Acme blog'>
      <meta property="og:image" content="/img/reviews.png">
      <meta name="description" content="Plain description">
    </head><body>`;
    expect(parseOpenGraph(html, 'https://acme.example.com/blog/design-reviews')).toEqual({
      title: 'How we run design reviews',
      description: 'Who comes, what to bring, & how decisions get written down.',
      site: 'Acme blog',
      image: 'https://acme.example.com/img/reviews.png',
    });
  });

  it('falls back to Twitter cards, then the title tag, the description, and the host', () => {
    const html = `<head><title>Error handling, a field guide</title><meta name="twitter:image" content="https://cdn.example.com/a.jpg"><meta name="description" content="Return errors where the caller can act."></head>`;
    expect(parseOpenGraph(html, 'https://www.docs.example.com/guide')).toEqual({
      title: 'Error handling, a field guide',
      description: 'Return errors where the caller can act.',
      site: 'docs.example.com',
      image: 'https://cdn.example.com/a.jpg',
    });
  });

  it('gives nulls for a bare page and drops a non-web image', () => {
    expect(parseOpenGraph('<head><meta property="og:image" content="javascript:alert(1)"></head>', 'https://x.example.com/')).toEqual({
      title: null,
      description: null,
      site: 'x.example.com',
      image: null,
    });
  });

  it('knows when the head has been read', () => {
    expect(headDone('<html><head><title>a')).toBe(false);
    expect(headDone('<head></head >')).toBe(true);
    expect(headDone('<head><meta x><body class="a">')).toBe(true);
  });
});
