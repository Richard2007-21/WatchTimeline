/*
 * WatchTimeline – a very small PNG reader and writer (Node.js zlib only).
 *
 * After Effects writes the frame of a 32-bit project as a 16-bit PNG in which
 * white is a tenth of the range (room for highlights). Opened as a normal
 * picture it is almost black. scale() multiplies the colours and writes an
 * ordinary 8-bit PNG, so Claude sees the frame as the viewer shows it.
 *
 * Reads: 8 or 16 bit, RGB or RGBA, not interlaced. Writes: 8-bit RGBA.
 */
'use strict';

var fs = require('fs');
var zlib = require('zlib');

var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var crcTable = null;

function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xffffffff;
  for (var i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// → { width, height, bitDepth, channels, data } with data = raw samples, row after row.
function decode(buf) {
  for (var s = 0; s < 8; s++) if (buf[s] !== SIGNATURE[s]) throw new Error('not a PNG file');
  var pos = 8;
  var head = null;
  var idat = [];
  while (pos + 8 <= buf.length) {
    var len = buf.readUInt32BE(pos);
    var type = buf.toString('ascii', pos + 4, pos + 8);
    var data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      head = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!head) throw new Error('PNG without header');
  if (head.interlace) throw new Error('interlaced PNG');
  if (head.colorType !== 2 && head.colorType !== 6) throw new Error('PNG colour type ' + head.colorType);
  if (head.bitDepth !== 8 && head.bitDepth !== 16) throw new Error('PNG bit depth ' + head.bitDepth);
  var channels = head.colorType === 6 ? 4 : 3;
  var bpp = channels * head.bitDepth / 8;
  var stride = head.width * bpp;
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var out = Buffer.alloc(stride * head.height);
  for (var y = 0; y < head.height; y++) {
    var filter = raw[y * (stride + 1)];
    var src = y * (stride + 1) + 1;
    var dst = y * stride;
    for (var x = 0; x < stride; x++) {
      var a = x >= bpp ? out[dst + x - bpp] : 0;                     // left
      var b = y > 0 ? out[dst + x - stride] : 0;                     // above
      var c = x >= bpp && y > 0 ? out[dst + x - stride - bpp] : 0;   // above left
      var v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        var p = a + b - c;
        var pa = Math.abs(p - a);
        var pb = Math.abs(p - b);
        var pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[dst + x] = v & 0xff;
    }
  }
  return { width: head.width, height: head.height, bitDepth: head.bitDepth, channels: channels, data: out };
}

// rgba: Buffer of width * height * 4 bytes.
function encode(width, height, rgba) {
  var stride = width * 4;
  var raw = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Multiplies the colours of a picture by factor. Returns 8-bit RGBA PNG bytes.
function scaleBuffer(buf, factor) {
  var img = decode(buf);
  var n = img.width * img.height;
  var out = Buffer.alloc(n * 4);
  var wide = img.bitDepth === 16;
  var step = img.channels * (wide ? 2 : 1);
  for (var i = 0; i < n; i++) {
    for (var ch = 0; ch < 4; ch++) {
      var v = 255;
      if (ch < img.channels) {
        var o = i * step + ch * (wide ? 2 : 1);
        v = wide ? ((img.data[o] << 8) | img.data[o + 1]) / 257 : img.data[o];
        if (ch < 3) v *= factor;
      }
      out[i * 4 + ch] = v > 255 ? 255 : (v < 0 ? 0 : Math.round(v));
    }
  }
  return encode(img.width, img.height, out);
}

function scale(file, factor) {
  fs.writeFileSync(file, scaleBuffer(fs.readFileSync(file), factor));
}

module.exports = { decode: decode, encode: encode, scaleBuffer: scaleBuffer, scale: scale, chunk: chunk };
