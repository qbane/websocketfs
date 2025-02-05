import { SftpPacket, SftpPacketWriter, SftpPacketReader } from "./sftp-packet";
import { SftpFlags, SftpAttributes, SftpExtensions } from "./sftp-misc";
import { SftpPacketType, SftpStatusCode } from "./sftp-enums";
import { IStats, IItem, RenameFlags, IFilesystem } from "./fs-api";
import { FilesystemPlus, Task } from "./fs-plus";
import { Path } from "./fs-misc";
import { IChannel } from "./channel";
import { ILogWriter, LogHelper, LogLevel } from "./util";
import debug from "debug";

const log = debug("websocketfs:sftp-client");
import { SftpVfsStats } from "./sftp-misc";

export const MAX_WRITE_BLOCK_LENGTH = 1024 * 1024;
export const MAX_READ_BLOCK_LENGTH = 1024 * 1024;

interface SftpRequest {
  callback: Function;
  responseParser: (reply: SftpPacket, callback: Function) => void;
  info: SftpCommandInfo;
}

interface SftpResponse extends SftpPacketReader {
  info: SftpCommandInfo;
}

interface SftpCommandInfo extends Object {
  command: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  targetPath?: string;
  linkPath?: string;
  handle?: any;
  fromHandle?: any;
  toHandle?: any;
}

class SftpItem implements IItem {
  filename: string;
  longname: string;
  stats: SftpAttributes;
}

// In our implementation of the server, handles are 4-bytes, hence
// can be represented as a 32-bit signed integer.
export class SftpHandle {
  _handle: Buffer;
  _this: SftpClientCore;

  constructor(handle: Buffer, owner: SftpClientCore) {
    this._handle = handle;
    this._this = owner;
  }

  toFileDescriptor(): number {
    // handles are always 4 bytes in our implementation, so
    // can represent as a 32-bit number.  In fact, the handle
    // is an actual file descriptor (nonnegative number) as
    // returned by the fs module.
    // Using Int32BE to stay consistent with server side code.
    return this._handle.readInt32BE(0);
  }

  toString(): string {
    let value = "0x";
    for (let i = 0; i < this._handle.length; i++) {
      const b = this._handle[i];
      const c = b.toString(16);
      if (b < 16) {
        value += "0";
      }
      value += c;
    }
    return value;
  }
}

class SftpFeature {
  static HARDLINK = "LINK";
  static POSIX_RENAME = "POSIX_RENAME";
  static COPY_FILE = "COPY_FILE";
  static COPY_DATA = "COPY_DATA";
  static CHECK_FILE_HANDLE = "CHECK_FILE_HANDLE";
  static CHECK_FILE_NAME = "CHECK_FILE_NAME";
  static STATVFS = "STATVFS";
}

class SftpClientCore implements IFilesystem {
  private static _nextSessionId = 1;
  private _sessionId: number;

  private _host: IChannel | null;
  private _id: number | null;
  private _requests: SftpRequest[];
  private _extensions: Object;
  private _features: Object;

  private _log: ILogWriter;
  private _trace: boolean;

  private _maxReadBlockLength: number;
  private _maxWriteBlockLength: number;

  private _bytesReceived: number;
  private _bytesSent: number;

  private getRequest(type: SftpPacketType | string): SftpPacketWriter {
    const request = new SftpPacketWriter(this._maxWriteBlockLength + 1024);

    request.type = type;
    request.id = this._id;

    if (type == SftpPacketType.INIT) {
      if (this._id != null) {
        throw Error("Already initialized");
      }
      this._id = 1;
    } else {
      if (this._id == null) {
        throw Error("Must be initialized first");
      }
      this._id = (this._id + 1) & 0xffffffff;
    }

    request.start();
    return request;
  }

  private writeStats(packet: SftpPacketWriter, attrs?: IStats): void {
    const pattrs = new SftpAttributes();
    pattrs.from(attrs);
    pattrs.write(packet);
  }

  constructor() {
    this._sessionId = SftpClientCore._nextSessionId++;
    this._host = null;
    this._id = null;
    this._requests = [];
    this._extensions = {};
    this._features = {};

    this._maxWriteBlockLength = MAX_WRITE_BLOCK_LENGTH;
    this._maxReadBlockLength = MAX_READ_BLOCK_LENGTH;

    this._bytesReceived = 0;
    this._bytesSent = 0;
  }

  getChannelStats(): {} {
    return {
      bytesReceived: this._bytesReceived,
      bytesSent: this._bytesSent,
    };
  }

  private execute(
    request: SftpPacketWriter,
    callback: Function,
    responseParser: (response: SftpResponse, callback: Function) => void,
    info: SftpCommandInfo,
  ): void {
    if (!this._host) {
      process.nextTick(() => {
        const error = this.createError(
          SftpStatusCode.NO_CONNECTION,
          "Not connected",
          info,
        );
        callback(error);
      });
      return;
    }

    if (request.id != null && this._requests[request.id] != null) {
      throw Error("Duplicate request");
    }

    const packet = request.finish();

    if (log.enabled) {
      // logging
      const meta: any = {};
      meta["session"] = this._sessionId;
      if (request.type != SftpPacketType.INIT) {
        meta["req"] = request.id;
      }
      meta["type"] = SftpPacket.toString(request.type ?? "");
      meta["length"] = packet.length;
      if (this._trace) {
        meta["raw"] = packet;
      }
      log("Sending request", meta);
    }

    this._host.send(packet);
    this._bytesSent += packet.length;

    // TOOD: The request.id when initializing really is null.
    // @ts-ignore
    this._requests[request.id] = {
      callback,
      responseParser,
      info,
    };
  }

  _init(
    host: IChannel,
    oldlog: ILogWriter,
    callback: (err?: Error) => any,
  ): void {
    if (this._host) {
      throw Error("Already bound");
    }

    this._host = host;
    this._extensions = {};

    this._log = oldlog;

    // determine the log level now to speed up logging later
    const level = LogHelper.getLevel(oldlog);
    this._trace = level <= LogLevel.TRACE;

    const request = this.getRequest(SftpPacketType.INIT);

    request.writeInt32(3); // SFTPv3

    const info = { command: "init" };

    log("sftp._init: sending INIT packet");
    this.execute(
      request,
      callback,
      (response, _cb) => {
        log("sftp._init: got back ", response);
        if (response.type != SftpPacketType.VERSION) {
          host.close(3002);
          //           const error = this.createError(
          //             SftpStatusCode.BAD_MESSAGE,
          //             "Unexpected message",
          //             info
          //           );
          return callback(Error("Protocol violation"));
        }

        const version = response.readInt32();
        if (version != 3) {
          host.close(3002);
          const error = this.createError(
            SftpStatusCode.BAD_MESSAGE,
            "Unexpected protocol version",
            info,
          );
          return callback(error);
        }

        while (response.length - response.position >= 4) {
          const extensionName = response.readString();
          const value = SftpExtensions.read(response, extensionName);

          if (
            extensionName.indexOf("@openssh.com") ===
            extensionName.length - 12
          ) {
            // OpenSSH extensions may occur multiple times
            let val = <string>this._extensions[extensionName];
            if (typeof val === "undefined") {
              val = value;
            } else {
              val += "," + value;
            }
          }

          this._extensions[extensionName] = value;
        }

        this._log.debug(
          this._extensions,
          "[%d] - Server extensions",
          this._sessionId,
        );

        if (
          SftpExtensions.contains(
            this._extensions[SftpExtensions.HARDLINK],
            "1",
          )
        ) {
          this._features[SftpFeature.HARDLINK] = SftpExtensions.HARDLINK;
        }

        if (
          SftpExtensions.contains(
            this._extensions[SftpExtensions.POSIX_RENAME],
            "1",
          )
        ) {
          this._features[SftpFeature.POSIX_RENAME] =
            SftpExtensions.POSIX_RENAME;
        }

        this._features[SftpFeature.CHECK_FILE_HANDLE] =
          SftpExtensions.CHECK_FILE_HANDLE;
        this._features[SftpFeature.COPY_DATA] = SftpExtensions.COPY_DATA;
        this._features[SftpFeature.STATVFS] = SftpExtensions.STATVFS;

        callback();
      },
      info,
    );
  }

  _process(packet: ArrayBuffer): void {
    const buf = new Uint8Array(packet);
    this._bytesReceived += buf.length;
    const response = <SftpResponse>new SftpPacketReader(buf);

    if (log.enabled) {
      const meta: { [key: string]: any } = {};
      meta["session"] = this._sessionId;
      if (response.type != SftpPacketType.VERSION) {
        meta["req"] = response.id;
      }
      meta["type"] = SftpPacket.toString(response.type ?? "");
      meta["length"] = response.length;
      if (this._trace) {
        meta["buffer"] = response.buffer?.toString();
      }

      if (response.type == SftpPacketType.VERSION) {
        log("[%d] - Received version response %o", this._sessionId, meta);
      } else {
        log("[%d] #%d - Received response %o", this._sessionId, response.id, meta);
      }
    }

    // @ts-ignore -- id is sometimes null in the unit tests during init,
    // so this needs to be supported
    const request = this._requests[response.id];
    if (request == null) {
      throw Error("Unknown response ID");
    }
    // @ts-ignore
    delete this._requests[response.id];
    response.info = request.info;
    request.responseParser.call(this, response, request.callback);
  }

  end(): void {
    const host = this._host;
    if (host) {
      this._host = null;
      host.close();
    }
    this.failRequests(SftpStatusCode.CONNECTION_LOST, "Connection closed");
  }

  private failRequests(code: SftpStatusCode, message: string): void {
    const requests = this._requests;
    this._requests = [];

    requests.forEach((request) => {
      const error = this.createError(code, message, request.info);
      request.callback(error);
    });
  }

  open(
    path: string,
    flags: string | number,
    attrs: IStats,
    callback: (err: Error, handle: SftpHandle) => any,
  ): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    const request = this.getRequest(SftpPacketType.OPEN);

    request.writeString(path);
    const flagNumber = SftpFlags.toNumber(flags);
    request.writeInt32(flagNumber);
    this.writeStats(request, attrs);

    this.execute(request, callback, this.parseHandle, {
      command: "open",
      path,
    });
  }

  close(handle: any, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);

    const request = this.getRequest(SftpPacketType.CLOSE);

    request.writeData(h);

    this.execute(request, callback, this.parseStatus, {
      command: "close",
      handle: handle,
    });
  }

  read(
    handle: any,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error, buffer: Buffer, bytesRead: number) => any,
  ): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);
    if (buffer) {
      this.checkBuffer(buffer, offset, length);
    }
    this.checkPosition(position);

    // make sure the length is within reasonable limits
    if (length > this._maxReadBlockLength) {
      const error = Error(
        `Length ${length} exceeds maximum allowed read data block length ${this._maxReadBlockLength}`,
      );
      error["code"] = "EIO";
      error["errno"] = 55;
      callback(error, buffer, 0);
      return;
    }

    const request = this.getRequest(SftpPacketType.READ);

    request.writeData(h);
    request.writeInt64(position);
    request.writeInt32(length);

    this.execute(
      request,
      callback,
      (response, _cb) =>
        this.parseData(
          response,
          callback,
          0,
          h,
          buffer,
          offset,
          length,
          position,
        ),
      { command: "read", handle: handle },
    );
  }

  write(
    handle: any,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error) => any,
  ): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);
    this.checkBuffer(buffer, offset, length);
    this.checkPosition(position);

    if (length > this._maxWriteBlockLength) {
      const error = Error(
        `Length ${length} exceeds maximum allowed write data block length ${this._maxWriteBlockLength}`,
      );
      error["code"] = "EIO";
      error["errno"] = 55;
      callback(error);
      return;
    }

    const request = this.getRequest(SftpPacketType.WRITE);

    request.writeData(h);
    request.writeUInt64(position);
    request.writeData(buffer, offset, offset + length);

    this.execute(request, callback, this.parseStatus, {
      command: "write",
      handle,
    });
  }

  lstat(path: string, callback: (err: Error, attrs: IStats) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.LSTAT, [path], callback, this.parseAttribs, {
      command: "lstat",
      path,
    });
  }

  fstat(handle: any, callback: (err: Error, attrs: IStats) => any): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);

    const request = this.getRequest(SftpPacketType.FSTAT);

    request.writeData(h);

    this.execute(request, callback, this.parseAttribs, {
      command: "fstat",
      handle: handle,
    });
  }

  setstat(path: string, attrs: IStats, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    const request = this.getRequest(SftpPacketType.SETSTAT);

    request.writeString(path);
    this.writeStats(request, attrs);

    this.execute(request, callback, this.parseStatus, {
      command: "setstat",
      path: path,
    });
  }

  fsetstat(handle: any, attrs: IStats, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);

    const request = this.getRequest(SftpPacketType.FSETSTAT);

    request.writeData(h);
    this.writeStats(request, attrs);

    this.execute(request, callback, this.parseStatus, {
      command: "fsetstat",
      handle: handle,
    });
  }

  opendir(path: string, callback: (err: Error, handle: any) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.OPENDIR, [path], callback, this.parseHandle, {
      command: "opendir",
      path: path,
    });
  }

  readdir(
    handle: any,
    callback: (err: Error, items: IItem[] | false) => void,
  ): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);
    const request = this.getRequest(SftpPacketType.READDIR);
    request.writeData(h);
    this.execute(request, callback, this.parseItems, {
      command: "readdir",
      handle,
    });
  }

  unlink(path: string, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.REMOVE, [path], callback, this.parseStatus, {
      command: "unlink",
      path: path,
    });
  }

  mkdir(path: string, attrs: IStats, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    const request = this.getRequest(SftpPacketType.MKDIR);

    request.writeString(path);
    this.writeStats(request, attrs);

    this.execute(request, callback, this.parseStatus, {
      command: "mkdir",
      path,
    });
  }

  rmdir(path: string, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.RMDIR, [path], callback, this.parseStatus, {
      command: "rmdir",
      path,
    });
  }

  realpath(
    path: string,
    callback: (err: Error, resolvedPath: string) => any,
  ): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.REALPATH, [path], callback, this.parsePath, {
      command: "realpath",
      path: path,
    });
  }

  stat(path: string, callback: (err: Error, attrs: IStats) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.STAT, [path], callback, this.parseAttribs, {
      command: "stat",
      path: path,
    });
  }

  statvfs(path: string, callback: (err: Error, stats) => any): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");
    log("statvfs", { path });

    this.command(SftpPacketType.STATVFS, [path], callback, this.parseVfsStats, {
      command: "statvfs",
      path,
    });
  }

  rename(
    oldPath: string,
    newPath: string,
    flags: number,
    callback: (err: Error) => any,
  ): void {
    this.checkCallback(callback);
    oldPath = this.checkPath(oldPath, "oldPath");
    newPath = this.checkPath(newPath, "newPath");

    let command;
    const info = {
      command: "rename",
      oldPath,
      newPath,
      flags,
    };
    switch (flags) {
      case RenameFlags.OVERWRITE:
        command = SftpFeature.POSIX_RENAME;
        break;
      case 0:
        command = SftpPacketType.RENAME;
        break;
      default:
        process.nextTick(() =>
          callback(
            this.createError(
              SftpStatusCode.OP_UNSUPPORTED,
              "Unsupported rename flags",
              info,
            ),
          ),
        );
        break;
    }

    this.command(command, [oldPath, newPath], callback, this.parseStatus, info);
  }

  readlink(
    path: string,
    callback: (err: Error, linkString: string) => any,
  ): void {
    this.checkCallback(callback);
    path = this.checkPath(path, "path");

    this.command(SftpPacketType.READLINK, [path], callback, this.parsePath, {
      command: "readlink",
      path,
    });
  }

  symlink(
    targetPath: string,
    linkPath: string,
    callback: (err: Error) => any,
  ): void {
    this.checkCallback(callback);
    targetPath = this.checkPath(targetPath, "targetPath");
    linkPath = this.checkPath(linkPath, "linkPath");

    this.command(
      SftpPacketType.SYMLINK,
      [targetPath, linkPath],
      callback,
      this.parseStatus,
      { command: "symlink", targetPath: targetPath, linkPath: linkPath },
    );
  }

  link(oldPath: string, newPath: string, callback: (err: Error) => any): void {
    this.checkCallback(callback);
    oldPath = this.checkPath(oldPath, "oldPath");
    newPath = this.checkPath(newPath, "newPath");

    this.command(
      SftpFeature.HARDLINK,
      [oldPath, newPath],
      callback,
      this.parseStatus,
      { command: "link", oldPath: oldPath, newPath: newPath },
    );
  }

  fcopy(
    fromHandle: any,
    fromPosition: number,
    length: number,
    toHandle: any,
    toPosition: number,
    callback: (err: Error) => any,
  ): void {
    this.checkCallback(callback);
    const fh = this.toHandle(fromHandle);
    const th = this.toHandle(toHandle);
    this.checkPosition(fromPosition);
    this.checkPosition(toPosition);

    const request = this.getRequest(SftpExtensions.COPY_DATA);

    request.writeData(fh);
    request.writeInt64(fromPosition);
    request.writeInt64(length);
    request.writeData(th);
    request.writeInt64(toPosition);

    this.execute(request, callback, this.parseStatus, {
      command: "fcopy",
      fromHandle: fromHandle,
      toHandle: toHandle,
    });
  }

  fhash(
    handle: any,
    alg: string,
    position: number,
    length: number,
    blockSize: number,
    callback: (err: Error, hashes: Buffer, alg: string) => any,
  ): void {
    this.checkCallback(callback);
    const h = this.toHandle(handle);
    this.checkPosition(position);

    const request = this.getRequest(SftpExtensions.CHECK_FILE_HANDLE);

    request.writeData(h);
    request.writeString(alg);
    request.writeInt64(position);
    request.writeInt64(length);
    request.writeInt32(blockSize);

    this.execute(request, callback, this.parseHash, {
      command: "fhash",
      handle: handle,
    });
  }

  private checkCallback(callback: any): void {
    if (typeof callback !== "function")
      throw new Error("Callback must be a function");
  }

  private toHandle(handle: { _handle: Buffer; _this: SftpClientCore }): Buffer {
    if (!handle) {
      throw new Error("Missing handle");
    } else if (typeof handle === "object") {
      if (SftpPacket.isBuffer(handle._handle) && handle._this == this)
        return handle._handle;
    }

    throw new Error("Invalid handle");
  }

  private checkBuffer(buffer: Buffer, offset: number, length: number): void {
    if (!SftpPacket.isBuffer(buffer)) throw new Error("Invalid buffer");

    if (typeof offset !== "number" || offset < 0)
      throw new Error("Invalid offset");

    if (typeof length !== "number" || length < 0)
      throw new Error("Invalid length");

    if (offset + length > buffer.length)
      throw new Error("Offset or length is out of bounds");
  }

  private checkPath(path: string, name: string): string {
    path = Path.check(path, name);
    if (path[0] === "~") {
      if (path[1] === "/") {
        path = "." + path.substr(1);
      } else if (path.length == 1) {
        path = ".";
      }
    }
    return path;
  }

  private checkPosition(position: number): void {
    if (
      typeof position !== "number" ||
      position < 0 ||
      position > 0x7fffffffffffffff
    )
      throw new Error("Invalid position");
  }

  private command(
    command: SftpPacketType | string,
    args: string[],
    callback: Function,
    responseParser: (response: SftpResponse, callback: Function) => void,
    info: SftpCommandInfo,
  ): void {
    if (typeof command !== "number") {
      command = this._features[command];
    }

    if (!command) {
      process.nextTick(() =>
        callback(
          this.createError(
            SftpStatusCode.OP_UNSUPPORTED,
            "Operation not supported",
            info,
          ),
        ),
      );
      return;
    }

    const request = this.getRequest(command);

    for (let i = 0; i < args.length; i++) {
      request.writeString(args[i]);
    }

    this.execute(request, callback, responseParser, info);
  }

  private readStatus(response: SftpResponse): Error | null {
    const nativeCode = response.readInt32();
    const message = response.readString();
    if (nativeCode == SftpStatusCode.OK) {
      return null;
    }

    const info = response.info;
    return this.createError(nativeCode, message, info);
  }

  private readItem(response: SftpResponse): IItem {
    const item = new SftpItem();
    item.filename = response.readString();
    item.longname = response.readString();
    item.stats = new SftpAttributes(response);
    return item;
  }

  private createError(
    nativeCode: number,
    message: string,
    info: SftpCommandInfo,
  ) {
    let code;
    let errno;
    switch (nativeCode) {
      case SftpStatusCode.EOF:
        code = "EOF";
        errno = 1;
        break;
      case SftpStatusCode.NO_SUCH_FILE:
        code = "ENOENT";
        errno = 34;
        break;
      case SftpStatusCode.PERMISSION_DENIED:
        code = "EACCES";
        errno = 3;
        break;
      case SftpStatusCode.OK:
      case SftpStatusCode.FAILURE:
      case SftpStatusCode.BAD_MESSAGE:
        code = "EFAILURE";
        errno = -2;
        break;
      case SftpStatusCode.NO_CONNECTION:
        code = "ENOTCONN";
        errno = 31;
        break;
      case SftpStatusCode.CONNECTION_LOST:
        code = "ESHUTDOWN";
        errno = 46;
        break;
      case SftpStatusCode.OP_UNSUPPORTED:
        code = "ENOSYS";
        errno = 35;
        break;
      case SftpStatusCode.BAD_MESSAGE:
        code = "ESHUTDOWN";
        errno = 46;
        break;
      default:
        code = "UNKNOWN";
        errno = -1;
        break;
    }

    const command = info.command;
    let arg = info.path || info.handle;
    if (typeof arg === "string") {
      arg = "'" + arg + "'";
    } else if (arg) {
      arg = new String(arg);
    } else {
      arg = "";
    }

    const error = new Error(code + ", " + command + " " + arg);
    error["errno"] = errno;
    error["code"] = code;

    for (let name in info) {
      if (name == "command") {
        continue;
      }
      if (info.hasOwnProperty(name)) {
        error[name] = info[name];
      }
    }

    error["nativeCode"] = nativeCode;
    error["description"] = message;
    return error;
  }

  private checkResponse(
    response: SftpResponse,
    expectedType: number,
    callback: Function,
  ): boolean {
    if (response.type == SftpPacketType.STATUS) {
      const error = this.readStatus(response);
      if (error != null) {
        callback(error);
        return false;
      }
    }

    if (response.type != expectedType)
      throw new Error("Unexpected packet received");

    return true;
  }

  private parseStatus(
    response: SftpResponse,
    callback: (err: Error | null) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.STATUS, callback)) {
      return;
    }

    callback(null);
  }

  private parseAttribs(
    response: SftpResponse,
    callback: (err: Error | null, attrs: IStats) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.ATTRS, callback)) {
      return;
    }

    const attrs = new SftpAttributes(response);
    attrs.flags = 0;

    callback(null, attrs);
  }

  private parseVfsStats(
    response: SftpResponse,
    callback: (err: Error | null, attrs: IStats) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.VFSSTATS, callback)) {
      return;
    }

    const stats = new SftpVfsStats(response);

    callback(null, stats);
  }

  private parseHandle(
    response: SftpResponse,
    callback: (err: Error | null, handle: any) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.HANDLE, callback)) {
      return;
    }

    const handle = response.readData(true);

    callback(null, new SftpHandle(handle as Buffer, this));
  }

  private parsePath(
    response: SftpResponse,
    callback: (err: Error | null, path?: string) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.NAME, callback)) {
      return;
    }

    const count = response.readInt32();
    if (count != 1) {
      throw new Error("Invalid response");
    }

    const path = response.readString();

    callback(null, path);
  }

  private parseData(
    response: SftpResponse,
    callback: (
      err: Error | null,
      buffer: Uint8Array | null,
      bytesRead: number,
    ) => any,
    retries: number,
    h: Uint8Array,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): void {
    if (response.type == SftpPacketType.STATUS) {
      const error = this.readStatus(response);
      if (error != null) {
        if (error["nativeCode"] == SftpStatusCode.EOF) {
          buffer = buffer ? buffer.slice(offset, 0) : Buffer.alloc(0);
          callback(null, buffer, 0);
        } else {
          callback(error, null, 0);
        }
        return;
      }
    }

    const data = response.readData(false);

    if (data.length > length) {
      throw new Error("Received too much data");
    }

    length = data.length;
    if (length == 0) {
      // workaround for broken servers such as Globalscape 7.1.x that occasionally send empty data

      if (retries > 4) {
        const error = this.createError(
          SftpStatusCode.FAILURE,
          "Unable to read data",
          response.info,
        );
        error["code"] = "EIO";
        error["errno"] = 55;

        callback(error, null, 0);
        return;
      }

      const request = this.getRequest(SftpPacketType.READ);
      request.writeData(h);
      request.writeInt64(position);
      request.writeInt32(length);

      this.execute(
        request,
        callback,
        (response, _cb) =>
          this.parseData(
            response,
            callback,
            retries + 1,
            h,
            buffer,
            offset,
            length,
            position,
          ),
        response.info,
      );
      return;
    }

    if (!buffer) {
      buffer = data;
    } else {
      buffer.set(data, offset);
    }

    callback(null, buffer, length);
  }

  private parseItems(
    response: SftpResponse,
    callback: (err: Error | null, items?: IItem[] | boolean) => any,
  ): void {
    if (response.type == SftpPacketType.STATUS) {
      const error = this.readStatus(response);
      if (error != null) {
        if (error["nativeCode"] == SftpStatusCode.EOF) {
          callback(null, false);
        } else {
          callback(error);
        }
        return;
      }
    }

    if (response.type != SftpPacketType.NAME)
      throw new Error("Unexpected packet received");

    const count = response.readInt32();

    const items: IItem[] = [];
    for (let i = 0; i < count; i++) {
      items[i] = this.readItem(response);
    }

    callback(null, items);
  }

  private parseHash(
    response: SftpResponse,
    callback: (err: Error | null, hashes: Uint8Array, alg: string) => any,
  ): void {
    if (!this.checkResponse(response, SftpPacketType.EXTENDED_REPLY, callback))
      return;

    const alg = response.readString();
    const hashes = response.readData(false);

    callback(null, hashes, alg);
  }

  fileDescriptorToHandle(fd: number): SftpHandle {
    const handle = Buffer.alloc(4);
    handle.writeInt32BE(fd, 0);
    return new SftpHandle(handle, this);
  }
}

export interface ISftpClientEvents<T> {
  on(event: "ready", listener: () => void): T;
  on(event: "error", listener: (err: Error) => void): T;
  on(event: "close", listener: (err: Error) => void): T;
  on(event: string, listener: Function): T;

  once(event: "ready", listener: () => void): T;
  once(event: "error", listener: (err: Error) => void): T;
  once(event: "close", listener: (err: Error) => void): T;
  once(event: string, listener: Function): T;
}

export class SftpClient extends FilesystemPlus {
  private _bound: boolean = false;

  constructor(local: IFilesystem | null) {
    const sftp = new SftpClientCore();
    super(sftp, local ?? undefined);
  }

  getChannelStats(): {} {
    return (<SftpClientCore>this._fs).getChannelStats();
  }

  bind(
    channel: IChannel,
    options?: any,
    callback?: (err: Error | null) => void,
  ): Task<void> {
    if (typeof callback === "undefined" && typeof options === "function") {
      callback = options;
      options = null;
    }

    return super._task(callback, (callback) =>
      this._bind(channel, options, callback),
    );
  }

  fileDescriptorToHandle(fd: number) {
    return (this._fs as SftpClientCore).fileDescriptorToHandle(fd);
  }

  protected _bind(
    channel: IChannel,
    options: any,
    callback: undefined | ((err: Error | null) => void),
  ): void {
    log("_bind");
    const sftp = this._fs as SftpClientCore;

    if (this._bound) {
      callback?.(Error("Already bound"));
      callback = undefined;
      return;
    }
    this._bound = true;

    const oldlog = LogHelper.toLogWriter(options && options.log);

    log("sftp._init: calling");
    sftp._init(channel, oldlog, (err) => {
      log("sftp._init: returned");
      if (err) {
        sftp.end();
        this._bound = false;
        callback?.(err);
        callback = undefined;
      } else {
        callback?.(null);
        callback = undefined;
        this.emit("ready");
      }
    });

    channel.on("message", (packet) => {
      try {
        sftp._process(packet);
      } catch (err) {
        this.emit("error", err);
      }
    });

    channel.on("close", (err) => {
      if (callback != null) {
        // callback will be null if init finished
        callback?.(err);
        callback = undefined;
        return;
      }
      sftp.end();
      this._bound = false;

      if (!this.emit("close", err)) {
        // if an error occured and no close handler is available, raise an error
        if (err) {
          this.emit("error", err);
        }
      }
    });
  }

  end(): void {
    const sftp = this._fs as SftpClientCore;
    sftp.end();
    this.emit("close", null);
  }
}
