// test/screencast-bands.mjs —— 给「逐帧观感」用的最小工具：解 PNG + 按横带比对两帧。
//
// 为什么需要它：DOM 侧的 MutationObserver 只能告诉我们「节点什么时候进了文档」，
// 不能告诉我们「屏幕上是哪一截内容」。要判定「从上到下出现」还是「底部先出现」，
// 只能看**真的被画出来的帧**。CDP 的 Page.startScreencast 会把合成器每帧的产物推过来
// （png，无隔行，bit depth 8），这里把它解成像素做横带比对。
//
// 只支持 CDP 实际会返回的形状：PNG colorType 2(RGB)/6(RGBA)、depth 8、非隔行。

import zlib from 'node:zlib';

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported png bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('unsupported interlaced png');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported png color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[x] = value & 0xff;
    }
    previous = out;
  }
  return { width, height, channels, pixels };
}

/** 把 `rect`（CSS px，与截图 1:1）按竖直方向切成 bands 段，返回每段相对 `reference` 的平均像素差（0–255）。 */
export function bandDiff(image, reference, rect, bands = 6) {
  const { width, height, channels, pixels } = image;
  const x0 = Math.max(0, Math.round(rect.left));
  const x1 = Math.min(width, Math.round(rect.right));
  const y0 = Math.max(0, Math.round(rect.top));
  const y1 = Math.min(height, Math.round(rect.bottom));
  const result = [];
  for (let band = 0; band < bands; band += 1) {
    const by0 = y0 + Math.floor(((y1 - y0) * band) / bands);
    const by1 = y0 + Math.floor(((y1 - y0) * (band + 1)) / bands);
    let sum = 0;
    let count = 0;
    for (let y = by0; y < by1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * channels;
        const other = (y * reference.width + x) * reference.channels;
        sum += Math.abs(pixels[at] - reference.pixels[other]) + Math.abs(pixels[at + 1] - reference.pixels[other + 1]) + Math.abs(pixels[at + 2] - reference.pixels[other + 2]);
        count += 3;
      }
    }
    result.push(count ? Math.round((sum / count) * 100) / 100 : 0);
  }
  return result;
}

/** 这块区域是不是「一整片同一个颜色」（空白/未画任何内容）。 */
export function isUniform(image, rect) {
  const { width, height, channels, pixels } = image;
  const x0 = Math.max(0, Math.round(rect.left));
  const x1 = Math.min(width, Math.round(rect.right));
  const y0 = Math.max(0, Math.round(rect.top));
  const y1 = Math.min(height, Math.round(rect.bottom));
  const first = (y0 * width + x0) * channels;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * channels;
      if (pixels[at] !== pixels[first] || pixels[at + 1] !== pixels[first + 1] || pixels[at + 2] !== pixels[first + 2]) return false;
    }
  }
  return true;
}
