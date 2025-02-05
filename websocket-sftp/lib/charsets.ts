// use native encoder/decoder for stateless operations:
// https://github.com/sindresorhus/uint8array-extras/blob/main/index.js

const decoder = new TextDecoder()

export function uint8ArrayToString(value: Uint8Array): string {
  return decoder.decode(value)
}

const encoder = new TextEncoder()

export function stringToUint8Array(value: string): Uint8Array {
  return encoder.encode(value)
}

// TODO: can switch to TextEncoderStream/TextDecoderStream in the future

export interface IStringEncoder extends StringEncoder {}

export interface IStringDecoder extends StringDecoder {}

export class Encoding {
  constructor(name: string = "utf8") {
    const encoding = (name + "").toLowerCase().replace("-", "");
    if (encoding != "utf8") {
      throw Error("Encoding not supported: " + name);
    }
  }

  static UTF8 = new Encoding("utf8");

  getEncoder(value: string): IStringEncoder {
    return new StringEncoder(value);
  }

  getDecoder(): IStringDecoder {
    return new StringDecoder();
  }

  encode(value: string, buffer: Uint8Array, offset: number, end?: number): number {
    const result = encoder.encodeInto(value, buffer.subarray(offset, end));
    if (result.read! < value.length) return -1;
    return result.written!;
  }

  decode(buffer: Uint8Array, offset: number, end?: number): string {
    buffer = buffer.subarray(offset, end);
    return uint8ArrayToString(buffer);
  }
}

const enum UnicodeChars {
  REPLACEMENT_CHAR = 0xfffd,
  BOM = 0xfeff,
}

export class StringEncoder {
  private _value: string;
  private _done: boolean;

  finished(): boolean {
    return this._done;
  }

  constructor(value: string) {
    if (typeof value !== "string") {
      value = "" + value;
    }
    this._value = value;
  }

  read(buffer: Uint8Array, offset: number, end?: number): number {
    return encodeUTF8(this._value, buffer, offset, end, <any>this);
  }
}

export function encodeUTF8(
  value: string,
  buffer: Uint8Array,
  offset: number,
  end?: number,
  state?: { _code: number; _length: number; _position: number; _done: boolean },
): number {
  end = end || buffer.length;

  let code: number;
  let length: number;
  let position: number;
  if (state) {
    code = state._code ?? 0;
    length = state._length ?? 0;
    position = state._position ?? 0;
  } else {
    code = 0;
    length = 0;
    position = 0;
  }

  let done = false;
  const start = offset;

  while (true) {
    if (length > 0) {
      if (offset >= end) break;

      // emit multi-byte sequences
      buffer[offset++] = (code >> 12) | 0x80;

      if (length > 1) {
        code = (code & 0xfff) << 6;
        length--;
        continue;
      }

      // proceed to next character
      length = 0;
      code = 0;
    }

    // fetch next string if needed
    if (position >= value.length) {
      position = 0;

      // if the string ends normally, we are done
      if (code == 0) {
        done = true;
        break;
      }

      // if the string ends with a lone high surrogate, emit a replacement character instead
      value = String.fromCharCode(UnicodeChars.REPLACEMENT_CHAR);
      code = 0;
    }

    if (offset >= end) break;

    const c = value.charCodeAt(position++);
    if (code == 0) {
      code = c;

      // handle high surrogate
      if (c >= 0xd800 && c < 0xdc00) {
        code = 0x10000 + ((code & 0x3ff) << 10);
        continue;
      }

      // handle lone low surrogate
      if (c >= 0xdc00 && c < 0xe000) {
        code = UnicodeChars.REPLACEMENT_CHAR;
      } else {
        code = c;
      }
    } else {
      // handle low surrogate
      if (c >= 0xdc00 && c < 0xe000) {
        // calculate code
        code += c & 0x3ff;
      } else {
        // invalid low surrogate
        code = UnicodeChars.REPLACEMENT_CHAR;
      }
    }

    // emit first byte in a sequence and determine what to emit next
    if (code <= 0x7f) {
      buffer[offset++] = code;
      code = 0;
    } else if (code <= 0x7ff) {
      length = 1;
      buffer[offset++] = (code >> 6) | 0xc0;
      code = (code & 0x3f) << 12;
    } else if (code <= 0xffff) {
      length = 2;
      buffer[offset++] = (code >> 12) | 0xe0;
      code = (code & 0xfff) << 6;
    } else if (code <= 0x10ffff) {
      length = 3;
      buffer[offset++] = (code >> 18) | 0xf0;
      code = code & 0x1fffff;
    } else {
      code = UnicodeChars.REPLACEMENT_CHAR;
      length = 2;
      buffer[offset++] = (code >> 12) | 0xe0;
      code = (code & 0xfff) << 6;
    }
  }

  if (state) {
    state._code = code;
    state._length = length;
    state._position = position;
    state._done = done;
  } else {
    if (!done) return -1;
  }

  return offset - start;
}

class StringDecoder {
  private _text: string;
  private _removeBom: boolean;

  text(): string {
    return this._text;
  }

  write(buffer: Uint8Array, offset: number, end: number): void {
    // I think decodeUTF8 mutates this:
    decodeUTF8(buffer, offset, end, <any>this);
    const text = this._text;

    if (this._removeBom && text.length > 0) {
      if (text.charCodeAt(0) == UnicodeChars.BOM) {
        this._text = text.substr(1);
      }
      this._removeBom = false;
    }
  }
}

export function decodeUTF8(
  buffer: Uint8Array,
  offset: number,
  end?: number,
  state?: { _text?: string; _code?: number; _length?: number },
): string {
  end = end || buffer.length;

  let text: string;
  let code: number;
  let length: number;
  if (state) {
    text = state._text || "";
    code = state._code ?? 0;
    length = state._length ?? 0;
  } else {
    text = "";
    code = 0;
    length = 0;
  }

  while (offset < end) {
    const b = buffer[offset++];

    if (length > 0) {
      if ((b & 0xc0) != 0x80) {
        code = UnicodeChars.REPLACEMENT_CHAR;
        length = 0;
      } else {
        code = (code << 6) | (b & 0x3f);
        length--;
        if (length > 0) continue;
      }
    } else if (b <= 128) {
      code = b;
      length = 0;
    } else {
      switch (b & 0xe0) {
        case 0xe0:
          if (b & 0x10) {
            code = b & 0x07;
            length = 3;
          } else {
            code = b & 0xf;
            length = 2;
          }
          continue;
        case 0xc0:
          code = b & 0x1f;
          length = 1;
          continue;
        default:
          code = UnicodeChars.REPLACEMENT_CHAR;
          length = 0;
          break;
      }
    }

    // emit surrogate pairs for supplementary plane characters
    if (code >= 0x10000) {
      code -= 0x10000;
      if (code > 0xfffff) {
        code = UnicodeChars.REPLACEMENT_CHAR;
      } else {
        text += String.fromCharCode(0xd800 + ((code >> 10) & 0x3ff));
        code = 0xdc00 + (code & 0x3ff);
      }
    }

    text += String.fromCharCode(code);
  }

  if (state) {
    state._code = code;
    state._length = length;
    state._text = text;
    return text;
  } else {
    if (length > 0) {
      text += String.fromCharCode(UnicodeChars.REPLACEMENT_CHAR);
    }
    return text;
  }
}
