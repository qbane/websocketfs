import { stringToUint8Array, uint8ArrayToString } from "./charsets";
import { SftpPacketType } from "./sftp-enums";
// import { encodeUTF8 } from "./charsets";

export class SftpPacket {
  type: SftpPacketType | string | null = null;
  id: number | null = null;

  buffer: Uint8Array;
  position: number;
  length: number;

  constructor() {}

  check(count: number): void {
    const remaining = this.length - this.position;
    if (count > remaining) throw new Error("Unexpected end of packet");
  }

  skip(count: number): void {
    this.check(count);
    this.position += count;
  }

  resize(size: number): void {
    this.buffer = this.buffer.subarray(0, size);
  }

  static isBuffer(obj: any): boolean {
    return obj && obj.buffer instanceof ArrayBuffer && typeof obj.byteLength !== "undefined";
  }

  static toString(packetType: SftpPacketType | string): string {
    if (typeof packetType === "string") return packetType;
    switch (packetType) {
      case SftpPacketType.INIT:
        return "INIT";
      case SftpPacketType.VERSION:
        return "VERSION";
      case SftpPacketType.OPEN:
        return "OPEN";
      case SftpPacketType.CLOSE:
        return "CLOSE";
      case SftpPacketType.READ:
        return "READ";
      case SftpPacketType.WRITE:
        return "WRITE";
      case SftpPacketType.LSTAT:
        return "LSTAT";
      case SftpPacketType.FSTAT:
        return "FSTAT";
      case SftpPacketType.SETSTAT:
        return "SETSTAT";
      case SftpPacketType.FSETSTAT:
        return "FSETSTAT";
      case SftpPacketType.OPENDIR:
        return "OPENDIR";
      case SftpPacketType.READDIR:
        return "READDIR";
      case SftpPacketType.REMOVE:
        return "REMOVE";
      case SftpPacketType.MKDIR:
        return "MKDIR";
      case SftpPacketType.RMDIR:
        return "RMDIR";
      case SftpPacketType.REALPATH:
        return "REALPATH";
      case SftpPacketType.STAT:
        return "STAT";
      case SftpPacketType.RENAME:
        return "RENAME";
      case SftpPacketType.READLINK:
        return "READLINK";
      case SftpPacketType.SYMLINK:
        return "SYMLINK";
      case SftpPacketType.EXTENDED:
        return "EXTENDED";
      case SftpPacketType.STATUS:
        return "STATUS";
      case SftpPacketType.HANDLE:
        return "HANDLE";
      case SftpPacketType.DATA:
        return "DATA";
      case SftpPacketType.NAME:
        return "NAME";
      case SftpPacketType.ATTRS:
        return "ATTRS";
      case SftpPacketType.EXTENDED_REPLY:
        return "EXTENDED_REPLY";
      default:
        return "" + packetType;
    }
  }
}

export class SftpPacketReader extends SftpPacket {
  constructor(buffer: Uint8Array, raw?: boolean) {
    super();

    this.buffer = buffer;
    this.position = 0;
    this.length = buffer.length;

    if (!raw) {
      const length = this.readInt32() + 4;
      if (length != this.length) throw new Error("Invalid packet received");

      this.type = this.readByte();
      if (
        this.type == SftpPacketType.INIT ||
        this.type == SftpPacketType.VERSION
      ) {
        this.id = null;
      } else {
        this.id = this.readInt32();

        if (this.type == SftpPacketType.EXTENDED) {
          this.type = this.readString();
        }
      }
    } else {
      this.type = null;
      this.id = null;
    }
  }

  readByte(): number {
    this.check(1);
    const value = this.buffer[this.position++] & 0xFF;
    return value;
  }

  readInt16(): number {
    let value = this.readUInt16();
    if (value & 0x8000) value -= 0x10000;
    return value;
  }

  readUInt16(): number {
    this.check(2);
    let value = 0;
    value |= (this.buffer[this.position++] & 0xFF) << 8;
    value |= (this.buffer[this.position++] & 0xFF);
    return value;
  }

  readInt32(): number {
    let value = this.readUInt32();
    if (value & 0x80000000) value -= 0x100000000;
    return value;
  }

  readUInt32(): number {
    this.check(4);
    let value = 0;
    value |= (this.buffer[this.position++] & 0xFF) << 24;
    value |= (this.buffer[this.position++] & 0xFF) << 16;
    value |= (this.buffer[this.position++] & 0xFF) << 8;
    value |= (this.buffer[this.position++] & 0xFF);
    return value;
  }

  readInt64(): number {
    const hi = this.readInt32();
    const lo = this.readUInt32();

    const value = hi * 0x100000000 + lo;
    return value;
  }

  readUInt64(): number {
    const hi = this.readUInt32();
    const lo = this.readUInt32();
    const value = hi * 0x100000000 + lo;
    return value;
  }

  readString(): string {
    const length = this.readUInt32();
    this.check(length);
    const end = this.position + length;
    const slice = this.buffer.subarray(this.position, end);
    const value = uint8ArrayToString(slice);
    this.position = end;
    return value;
  }

  skipString(): void {
    const length = this.readInt32();
    this.check(length);

    const end = this.position + length;
    this.position = end;
  }

  readData(clone: boolean): Uint8Array {
    const length = this.readUInt32();
    this.check(length);

    const start = this.position;
    const end = start + length;
    this.position = end;
    const view = this.buffer.subarray(start, end);
    if (clone) {
      const buffer = new Uint8Array(length);
      buffer.set(view, 0);
      return buffer;
    } else {
      return view;
    }
  }

  readStructuredData(): SftpPacketReader {
    const data = this.readData(false);
    return new SftpPacketReader(data, true);
  }
}

export class SftpPacketWriter extends SftpPacket {
  constructor(length: number) {
    super();
    this.buffer = Buffer.alloc(length);
    this.position = 0;
    this.length = length;
  }

  start(): void {
    this.position = 0;
    this.writeInt32(0); // length placeholder

    if (typeof this.type === "number") {
      this.writeByte(<number>this.type);
    } else {
      this.writeByte(<number>SftpPacketType.EXTENDED);
    }

    if (
      this.type == SftpPacketType.INIT ||
      this.type == SftpPacketType.VERSION
    ) {
      // these packets don't have an id
    } else {
      this.writeInt32(this.id ?? 0);

      if (typeof this.type !== "number") {
        this.writeString(<string>this.type);
      }
    }
  }

  finish(): Uint8Array {
    const length = this.position;
    this.position = 0;
    this.writeInt32(length - 4);
    return this.buffer.subarray(0, length);
  }

  writeByte(value: number): void {
    this.check(1);
    this.buffer[this.position++] = value & 0xFF;
  }

  writeInt32(value: number): void {
    this.check(4);
    this.buffer[this.position++] = (value >> 24) & 0xFF;
    this.buffer[this.position++] = (value >> 16) & 0xFF;
    this.buffer[this.position++] = (value >> 8) & 0xFF;
    this.buffer[this.position++] = value & 0xFF;
  }

  // @deprecated
  writeUInt32(value: number): void {
    return this.writeInt32(value);
  }

  writeInt64(value: number): void {
    const hi = (value / 0x100000000) | 0;
    const lo = (value & 0xffffffff) | 0;
    this.writeInt32(hi);
    this.writeInt32(lo);
  }

  // @deprecated
  writeUInt64(value: number): void {
    return this.writeInt64(value);
  }

  writeString(value: string): void {
    if (typeof value !== "string") value = "" + value;
    const offset = this.position;
    this.writeInt32(0); // will get overwritten later

    const encoded = stringToUint8Array(value);
    const bytesWritten = encoded.length;
    this.buffer.set(encoded, this.position);

    if (bytesWritten < 0) {
      console.warn("writeString: Not enough space in the buffer");
      throw new Error("Not enough space in the buffer");
    }

    // write number of bytes and seek back to the end
    this.position = offset;
    this.writeInt32(bytesWritten);
    this.position += bytesWritten;
  }

  writeData(data: Uint8Array, start?: number, end?: number): void {
    if (start != null) {
      data = data.slice(start, end);
    }

    const length = data.length;
    this.writeInt32(length);

    this.check(length);
    this.buffer.set(data, this.position);
    this.position += length;
  }
}
