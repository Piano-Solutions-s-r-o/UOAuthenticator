import { describe, expect, it } from 'vitest';

import {
  isRasterImageType,
  rasterImageExtension,
  sniffRasterImageType,
} from '../../src/utils/image-sniff.js';

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
}

function jpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
}

function webp(): Buffer {
  const buf = Buffer.alloc(24);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(16, 4);
  buf.write('WEBP', 8, 'ascii');
  return buf;
}

describe('sniffRasterImageType', () => {
  it('recognises the three accepted raster formats', () => {
    expect(sniffRasterImageType(png())).toBe('image/png');
    expect(sniffRasterImageType(jpeg())).toBe('image/jpeg');
    expect(sniffRasterImageType(webp())).toBe('image/webp');
  });

  it('rejects SVG, HTML, PDF and other non-raster payloads', () => {
    const rejected = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<!doctype html><html><body>hi</body></html>',
      '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n',
      'GIF89a some gif bytes here',
    ];

    for (const payload of rejected) {
      expect(sniffRasterImageType(Buffer.from(payload, 'binary'))).toBeNull();
    }
  });

  it('rejects a RIFF container that is not WebP', () => {
    const wav = Buffer.alloc(24);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffRasterImageType(wav)).toBeNull();
  });

  it('rejects empty and truncated buffers without throwing', () => {
    expect(sniffRasterImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffRasterImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffRasterImageType(undefined as unknown as Buffer)).toBeNull();
  });

  it('maps sniffed types to inline filename extensions', () => {
    expect(rasterImageExtension('image/png')).toBe('png');
    expect(rasterImageExtension('image/jpeg')).toBe('jpg');
    expect(rasterImageExtension('image/webp')).toBe('webp');
    expect(rasterImageExtension('image/svg+xml')).toBe('bin');
  });

  it('guards the accepted type list', () => {
    expect(isRasterImageType('image/png')).toBe(true);
    expect(isRasterImageType('image/svg+xml')).toBe(false);
    expect(isRasterImageType(null)).toBe(false);
  });
});
