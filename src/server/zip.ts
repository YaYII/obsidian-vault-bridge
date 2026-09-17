/**
 * 最小 ZIP 打包器（仅 store 模式，不压缩）。
 *
 * 用途：把插件自身打包成一个安装包，让 iPhone 能一次性下载后在「文件」App 里解压。
 * 刻意不引入第三方依赖——插件的服务端应当保持零运行时依赖。
 */

/** 预先算好的 CRC32 查表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 按 ZIP 规范拼出字节流。
 * 不压缩（method 0），因此实现里不需要 deflate，任何解压工具都能打开。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const writeUint32 = (value: number): Uint8Array => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return out;
  };
  const writeUint16 = (value: number): Uint8Array => {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value & 0xffff, true);
    return out;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = concat([
      writeUint32(0x04034b50), // 本地文件头签名
      writeUint16(20), // 解压所需版本
      writeUint16(0x0800), // 文件名使用 UTF-8
      writeUint16(0), // 压缩方法：store
      writeUint16(0), // 修改时间
      writeUint16(0), // 修改日期
      writeUint32(crc),
      writeUint32(size),
      writeUint32(size),
      writeUint16(nameBytes.length),
      writeUint16(0), // 扩展字段长度
      nameBytes,
    ]);

    chunks.push(localHeader, entry.data);

    central.push(
      concat([
        writeUint32(0x02014b50), // 中央目录签名
        writeUint16(20), // 创建版本
        writeUint16(20), // 解压所需版本
        writeUint16(0x0800),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint32(crc),
        writeUint32(size),
        writeUint32(size),
        writeUint16(nameBytes.length),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint16(0),
        writeUint32(0),
        writeUint32(offset),
        nameBytes,
      ])
    );

    offset += localHeader.length + size;
  }

  const centralBytes = concat(central);
  const endRecord = concat([
    writeUint32(0x06054b50), // 中央目录结束签名
    writeUint16(0),
    writeUint16(0),
    writeUint16(entries.length),
    writeUint16(entries.length),
    writeUint32(centralBytes.length),
    writeUint32(offset),
    writeUint16(0),
  ]);

  return concat([...chunks, centralBytes, endRecord]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
