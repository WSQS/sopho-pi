// web/image-size.mjs —— 从 base64 图片**文件头**里读出「真实像素尺寸 / 真实类型」的那一小块纯函数。
//
// 为什么需要它（`docs/ops/tui-parity.md` M-31 前端那一半）：
//   wire 上一条消息的图片块只有 `{ type:'image', data(base64), mimeType }` —— **没有宽高**。
//   网页要画 `<img src="data:...">`，而「不给宽高就插图」会让**图片解码完的那一刻**整段正文长高：
//   加载前它是 0 高、加载后是几百像素高，正在读的人被顶走（这正是本仓 `test:streamjump-real`
//   / `test:connectflow` 在量的那类跳变）。所以尺寸必须在**插进 DOM 之前**就知道了。
//   已知的两条获取途径都不通：服务端加字段 = 改 wire 契约（派单红线：只消费已有字段）；
//   等 `img.onload` 再补 = 跳变已经发生了。
//   ⇒ 就地读图片文件头。这是**如实测出来的尺寸**（就是文件里字节写着的值），不是估的。
//
// 支持的四种格式 = pi 会产出 / 用户会贴的四种（`read` 工具产出 image/png、image/jpeg，剪贴板常见 png；
// gif/webp 是同一族的常见件）。认不出来就返回 `null` —— 调用方走「没有尺寸」的诚实降级，**不猜**。

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Map([...BASE64_ALPHABET].map((char, index) => [char, index]));

/** 只把这些字符当 base64 数据（去过空白；data URL 前缀不在这里，调用方切好）。 */
function normalizeBase64(data) {
  return String(data ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
}

/** base64 解出来的**真实字节数**（按 4 字符 = 3 字节、再减 padding 算 —— 与 `Buffer.byteLength(x,'base64')` 同口径）。
 *  返回 null ⇔ 这不是一份能认的 base64（有非法字符 / 长度不是 4 的倍数）——「未知」就报未知，不报 0。 */
export function exactBase64Bytes(data) {
  const clean = normalizeBase64(data);
  if (clean === '') return null;
  const body = clean.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  for (const char of body) if (!BASE64_VALUE.has(char)) return null;
  const padding = clean.length - body.length;
  return Math.floor((body.length * 3) / 4);
}

/** base64 前 `maxBytes` 个字节 —— 只够读文件头，不需要把整张图解出来。 */
export function base64HeadBytes(data, maxBytes = 8192) {
  const clean = normalizeBase64(data);
  const limit = Math.min(clean.length, Math.ceil(maxBytes / 3) * 4);
  const slice = clean.slice(0, limit - (limit % 4));
  const bytes = [];
  for (let index = 0; index < slice.length; index += 4) {
    const a = BASE64_VALUE.get(slice[index]);
    const b = BASE64_VALUE.get(slice[index + 1]);
    if (a === undefined || b === undefined) break; // '=' 或非法字符：到这儿就停
    const c = BASE64_VALUE.get(slice[index + 2]);
    const d = BASE64_VALUE.get(slice[index + 3]);
    bytes.push((a << 2) | (b >> 4));
    if (c === undefined || d === undefined) break;
    bytes.push(((b & 15) << 4) | (c >> 2));
    bytes.push(((c & 3) << 6) | d);
    if (bytes.length >= maxBytes) break;
  }
  return Uint8Array.from(bytes.slice(0, maxBytes));
}

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.slice(at, at + length));
const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const be16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];

/** 文件头的魔术数 → mime。认不出 ⇒ null（**不**按声明的 mimeType 假装认得）。 */
export function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** 文件头里的真实像素尺寸。四种格式各自读法见下；认不出 / 头不全 ⇒ null。 */
export function imageDimensions(bytes) {
  const mime = sniffImageMime(bytes);
  if (mime === 'image/png') {
    // IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节 'IHDR' 之后：宽 4 字节、高 4 字节（大端）。
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (mime === 'image/gif') {
    // Logical Screen Descriptor：宽 2 字节、高 2 字节（小端）。
    if (bytes.length < 10) return null;
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  if (mime === 'image/jpeg') {
    // 逐段扫到 SOFn（C0–CF，除掉 C4 霍夫曼表 / C8 / CC 算术表）：段内 1 byte 精度、2+2 高宽。
    let at = 2;
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1];
      if (marker === 0xff || marker === 0x00) { at += 1; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = be16(bytes, at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  if (mime === 'image/webp') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** 一步到位：base64 → { mime, width, height } —— 任何一项读不出来就那一项是 null（全读不出 ⇒ null）。 */
export function imageHeaderFacts(data) {
  const bytes = base64HeadBytes(data);
  if (bytes.length === 0) return null;
  const mime = sniffImageMime(bytes);
  const size = imageDimensions(bytes);
  if (!mime && !size) return null;
  return { mime, width: size?.width ?? null, height: size?.height ?? null };
}
