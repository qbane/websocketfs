/*
TODO: in this file "handle" really means "file descriptor".
It would be nice to rename things appropriately.

"Handle" is a notion defined in the sftp spec and file
descriptor is a different notion in POSIX file systems.
*/

import Path from "node:path";
import { IFilesystem, IItem, IStats, RenameFlags } from "./fs-api";
import { FileUtil } from "./fs-misc";
import crypto from "node:crypto";
import { MAX_WRITE_BLOCK_LENGTH } from "./sftp-client";
import debug from "debug";

const log = debug("websocketfs:fs-fsafe");

class HandleInfo {
  safe: number;
  real: any;
  busy: boolean;
  actions: Function[];
}

interface HandleToHandleInfoMap {
  [handle: number]: HandleInfo;
}

interface HashAlgToHashSizeMap {
  [alg: string]: number;
}

const _hashSizes: HashAlgToHashSizeMap = {};

export class SafeFilesystem implements IFilesystem {
  isSafe: boolean;
  private fs: IFilesystem;
  private isWindows: boolean;
  private root: string;
  private readOnly: boolean;
  private hideUidGid: boolean;

  private _handles: HandleToHandleInfoMap;
  private _nextHandle: number;
  // 1024 = standard linux default...
  private static MAX_HANDLE_COUNT = 1024;

  constructor(
    fs: IFilesystem,
    virtualRootPath: string,
    options: { readOnly?: boolean; hideUidGid?: boolean },
  ) {
    options = options || {};
    this.isSafe = true;
    this.fs = fs;
    this.isWindows = fs["isWindows"] === true;
    this.root = Path.normalize(virtualRootPath);
    this.readOnly = options.readOnly == true;
    this.hideUidGid = options.hideUidGid == true;
    this._handles = [];
    this._nextHandle = 1;
  }

  private createHandleInfo(): HandleInfo | null {
    // This approach to handles doesn't leak because JS arrays are sparse,
    // and also MAX_HANDLE_COUNT is small.
    let count = SafeFilesystem.MAX_HANDLE_COUNT;
    while (count-- > 0) {
      const safeHandle = this._nextHandle;
      this._nextHandle = (safeHandle % SafeFilesystem.MAX_HANDLE_COUNT) + 1;
      if (typeof this._handles[safeHandle] === "undefined") {
        const info = new HandleInfo();
        info.real = null;
        info.safe = safeHandle;
        info.busy = false;
        this._handles[safeHandle] = info;
        return info;
      }
    }

    return null;
  }

  private toHandleInfo(safeHandle: number): HandleInfo | null {
    if (typeof safeHandle !== "number") {
      return null;
    }
    return this._handles[safeHandle] || null;
  }

  private toVirtualPath(fullPath: string): string {
    let i = 0;
    let path: string;
    while (true) {
      if (i >= this.root.length) {
        path = fullPath.substr(this.root.length);
        break;
      }

      if (i >= fullPath.length) {
        //TODO: enhance this to reflect the real path
        path = "/";
        break;
      }

      if (this.root[i] != fullPath[i]) {
        //TODO: enhance this to reflect the real path
        path = "/";
        break;
      }

      i++;
    }

    if (this.isWindows) {
      path = path.replace(/\\/g, "/");
    }

    if (path.length == 0) {
      path = "/";
    }

    return path;
  }

  private toRealPath(path: string): string {
    path = Path.join("/", path);
    path = Path.join(this.root, path);
    return path;
  }

  private processCallbackPath(
    err: Error | null,
    path: string | undefined,
    callback: (err: Error | null, path?: string) => any,
  ) {
    if (err != null) {
      return callback(err);
    }
    if (path == null) {
      return callback(Error("path must be set"));
    }
    path = this.toVirtualPath(path);
    callback(err, path);
  }

  private processCallbackHandle(
    err: Error | null,
    handleInfo: HandleInfo | undefined | null,
    realHandle: any,
    callback: (err: Error | null, safeHandle?: number) => any,
  ) {
    if (handleInfo == null) {
      callback(err ?? Error("bug -- handleInfo must be specified"));
      return;
    }
    const safeHandle = handleInfo.safe;
    if (err) {
      delete this._handles[safeHandle];
      callback(err);
      return;
    }
    handleInfo.real = realHandle;
    callback(null, safeHandle);
  }

  private processCallbackAttrs(
    err: Error | null,
    attrs: IStats | undefined,
    callback: (err: Error | null, attrs?: IStats) => any,
  ) {
    if (attrs && this.hideUidGid) {
      delete attrs.uid;
      delete attrs.gid;
    }

    callback(err, attrs);
  }

  private isReadOnly(): boolean {
    return !(this.readOnly === false);
  }

  async end() {
    if (!this.fs) {
      return;
    }

    log("fs-safe: end - closing all open file handles");
    const close: typeof this.fs.close = this.fs.close.bind(this.fs);
    for (let handle = 1; handle <= SafeFilesystem.MAX_HANDLE_COUNT; handle++) {
      const handleInfo = this.toHandleInfo(handle);
      if (handleInfo && handleInfo.real !== null) {
        try {
          log("fs-safe: close ", handleInfo.real);
          await new Promise<void>((resolve, reject) => {
            close(handleInfo.real, (err: Error) => {
              err ? reject(err) : resolve()
            })
          })
        } catch (err) {
          log("end: error closing one file handle", err);
        }
      }
      delete this._handles[handle];
    }

    // @ts-ignore
    delete this.fs;
  }

  private _execute(
    safeHandle: number,
    action: (
      handle: any,
      callback: (err: Error | null, ...args) => any,
    ) => void,
    callback?: (err: Error | null, ...args) => any,
  ): void {
    const handleInfo = this.toHandleInfo(safeHandle);

    if (!handleInfo) {
      return FileUtil.fail("Invalid handle", callback);
    }

    let finished = false;
    let asynchronous = false;

    if (!handleInfo.busy) {
      handleInfo.busy = true;
      run();
    } else {
      let queue = handleInfo.actions;
      if (!queue) {
        queue = [];
        handleInfo.actions = queue;
      }
      queue.push(run);
    }

    function run() {
      if (handleInfo == null) {
        throw Error("bug");
      }
      try {
        action(handleInfo.real, done);
      } catch (err) {
        done(err);
      }
      asynchronous = true;
    }

    function done(err: Error) {
      if (finished) {
        // callback called more than once - must be an internal bug
        console.trace();
        log(
          "BUG in done -- a callback was called more than once - this indicates a bug in SFTP",
        );
        return;
      }
      finished = true;

      // delay this function until the next tick if action finished synchronously
      if (!asynchronous) {
        asynchronous = true;
        process.nextTick(() => done(err));
        return;
      }

      // trigger next action
      if (handleInfo == null) {
        throw Error("bug");
      }
      const queue = handleInfo.actions;
      if (!queue || queue.length == 0) {
        handleInfo.busy = false;
      } else {
        const next = queue.shift();
        if (next != null) {
          next();
        }
      }

      // invoke the callback
      if (typeof callback !== "function") {
        if (err) throw err;
      } else {
        callback.apply(null, arguments);
      }
    }
  }

  open(
    path: string,
    flags: string | number,
    attrs: IStats,
    callback: (err: Error, handle?: number) => any,
  ): void {
    if (this.isReadOnly() && flags != "r") {
      return FileUtil.fail("EROFS", callback);
    }

    const handleInfo = this.createHandleInfo();
    if (!handleInfo) {
      return FileUtil.fail("ENFILE", callback);
    }

    try {
      path = this.toRealPath(path);
      this.fs.open(path, flags, attrs, (err, realHandle) => {
        if (handleInfo == null) {
          throw Error("bug");
        }
        this.processCallbackHandle(err, handleInfo, realHandle, callback);
      });
    } catch (err) {
      callback(err);
    }
  }

  close(handle: number, callback: (err: Error) => any): void {
    this._execute(
      handle,
      (realHandle, callback) => {
        delete this._handles[handle];
        this.fs.close(realHandle, callback);
      },
      callback,
    );
  }

  read(
    handle: number,
    buffer,
    offset,
    length,
    position,
    callback: (err: Error, buffer: Buffer, bytesRead: number) => any,
  ): void {
    this._execute(
      handle,
      (handle, callback) =>
        this.fs.read(handle, buffer, offset, length, position, callback),
      callback,
    );
  }

  write(
    handle: number,
    buffer,
    offset,
    length,
    position,
    callback: (err: Error) => any,
  ): void {
    if (this.isReadOnly()) {
      return FileUtil.fail("EROFS", callback);
    }

    this._execute(
      handle,
      (handle, callback) => {
        this.fs.write(handle, buffer, offset, length, position, callback);
      },
      callback,
    );
  }

  lstat(
    path: string,
    callback: (err: Error | null, attrs?: IStats) => any,
  ): void {
    path = this.toRealPath(path);

    try {
      if (!this.hideUidGid) {
        this.fs.lstat(path, callback);
      } else {
        this.fs.lstat(path, (err, attrs) =>
          this.processCallbackAttrs(err, attrs, callback),
        );
      }
    } catch (err) {
      callback(err);
    }
  }

  fstat(handle: number, callback: (err: Error, attrs: IStats) => any): void {
    this._execute(
      handle,
      (handle, callback) => this.fs.fstat(handle, callback),
      (err: Error, attrs: IStats) => {
        if (this.hideUidGid)
          return this.processCallbackAttrs(err, attrs, callback);
        callback(err, attrs);
      },
    );
  }

  setstat(path: string, attrs: IStats, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    if (this.hideUidGid) {
      delete attrs.uid;
      delete attrs.gid;
    }

    path = this.toRealPath(path);
    try {
      this.fs.setstat(path, attrs, callback);
    } catch (err) {
      callback(err);
    }
  }

  fsetstat(handle: number, attrs: IStats, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    if (attrs && this.hideUidGid) {
      delete attrs.uid;
      delete attrs.gid;
    }

    this._execute(
      handle,
      (handle, callback) => this.fs.fsetstat(handle, attrs, callback),
      callback,
    );
  }

  opendir(
    path: string,
    callback: (err: Error | null, handle?: number) => any,
  ): void {
    path = this.toRealPath(path);

    const handleInfo = this.createHandleInfo();
    if (!handleInfo) {
      return FileUtil.fail("ENFILE", callback);
    }

    try {
      this.fs.opendir(path, (err, realHandle) =>
        this.processCallbackHandle(err, handleInfo, realHandle, callback),
      );
    } catch (err) {
      callback(err);
    }
  }

  readdir(
    handle: number,
    callback: (err: Error, items: IItem[] | false) => any,
  ): void {
    this._execute(
      handle,
      (handle, callback) => this.fs.readdir(handle, callback),
      (err: Error, items: IItem[] | false) => {
        if (this.hideUidGid && items !== false) {
          items.forEach((item) => {
            delete item.stats.uid;
            delete item.stats.gid;
          });
        }
        callback(err, items);
      },
    );
  }

  unlink(path: string, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    path = this.toRealPath(path);

    try {
      this.fs.unlink(path, callback);
    } catch (err) {
      callback(err);
    }
  }

  mkdir(path: string, attrs: IStats, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    path = this.toRealPath(path);

    try {
      this.fs.mkdir(path, attrs, callback);
    } catch (err) {
      callback(err);
    }
  }

  rmdir(path: string, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    path = this.toRealPath(path);

    try {
      this.fs.rmdir(path, callback);
    } catch (err) {
      callback(err);
    }
  }

  realpath(
    path: string,
    callback: (err: Error | null, resolvedPath?: string) => any,
  ): void {
    path = this.toRealPath(path);

    try {
      this.fs.realpath(path, (err, resolvedPath) =>
        this.processCallbackPath(err, resolvedPath, callback),
      );
    } catch (err) {
      callback(err);
    }
  }

  stat(
    path: string,
    callback: (err: Error | null, attrs?: IStats) => any,
  ): void {
    path = this.toRealPath(path);

    try {
      if (!this.hideUidGid) {
        this.fs.stat(path, callback);
      } else {
        this.fs.stat(path, (err, attrs) =>
          this.processCallbackAttrs(err, attrs, callback),
        );
      }
    } catch (err) {
      callback(err);
    }
  }

  statvfs(path: string, callback: (err: Error | null, stats?) => any): void {
    path = this.toRealPath(path);
    this.fs.statvfs(path, callback);
  }

  rename(
    oldPath: string,
    newPath: string,
    flags: RenameFlags,
    callback: (err: Error) => any,
  ): void {
    if (this.isReadOnly()) {
      return FileUtil.fail("EROFS", callback);
    }

    oldPath = this.toRealPath(oldPath);
    newPath = this.toRealPath(newPath);

    try {
      this.fs.rename(oldPath, newPath, flags, callback);
    } catch (err) {
      callback(err);
    }
  }

  readlink(
    path: string,
    callback: (err: Error | null, linkString?: string) => any,
  ): void {
    const filePath = this.toRealPath(path);

    try {
      this.fs.readlink(filePath, callback);
    } catch (err) {
      callback(err);
    }
  }

  symlink(
    oldPath: string,
    newPath: string,
    callback: (err: Error | null) => any,
  ): void {
    if (this.isReadOnly()) {
      return FileUtil.fail("EROFS", callback);
    }

    oldPath = this.toRealPath(oldPath);
    // We *only* resolve to the absolute path if the target of the symlink
    // is given as an absolute path.  Otherwise it is a relative symlink,
    // and we better not resolve that!  This is a bug in upstream.
    newPath = Path.isAbsolute(newPath) ? this.toRealPath(newPath) : newPath;

    try {
      this.fs.symlink(oldPath, newPath, callback);
    } catch (err) {
      callback(err);
    }
  }

  link(oldPath: string, newPath: string, callback: (err: Error) => any): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    oldPath = this.toRealPath(oldPath);
    newPath = this.toRealPath(newPath);

    try {
      this.fs.link(oldPath, newPath, callback);
    } catch (err) {
      callback(err);
    }
  }

  fsync(handle: number, callback: (err: Error | null) => void): void {
    this._execute(
      handle,
      (handle, callback) => {
        if (this.fs.fsync != null) {
          this.fs.fsync(handle, callback);
        } else {
          FileUtil.fail("ENOSYS", callback);
        }
      },
      callback,
    );
  }

  fcopy(
    fromHandle: number,
    fromPosition: number,
    length: number,
    toHandle: number,
    toPosition: number,
    callback: (err: Error | null) => any,
  ): void {
    if (this.isReadOnly()) return FileUtil.fail("EROFS", callback);

    const fs = this.fs;
    const same = fromHandle === toHandle;
    const blockSize = MAX_WRITE_BLOCK_LENGTH;
    length = length > 0 ? length : -1;

    let fh: any;
    let th: any;
    let fc: Function;
    let tc: Function | null;
    let fr = false;
    let tr = false;

    //TODO: add argument checks
    //TODO: fail on overlapping ranges in a single file

    this._execute(fromHandle, (handle, callback) => {
      fh = handle;
      fc = callback;
      fr = true;

      if (same) {
        th = handle;
        tc = null;
        tr = true;
      }

      if (tr) start();
    });

    if (!same) {
      this._execute(toHandle, (handle, callback) => {
        th = handle;
        tc = callback;
        tr = true;
        if (fr) start();
      });
    }

    function done(err: Error | null) {
      fc();
      if (tc) tc();
      callback(err);
    }

    function start() {
      if (typeof fs.fcopy === "function") {
        fs.fcopy(fh, fromPosition, length, th, toPosition, done);
        return;
      }

      copy();
    }

    function copy() {
      const bytesToRead = length >= 0 ? Math.min(blockSize, length) : blockSize;
      if (bytesToRead == 0) {
        return done(null);
      }

      fs.read(
        fh,
        null,
        0,
        bytesToRead,
        fromPosition,
        (err, buffer, bytesRead) => {
          if (err) {
            return done(err);
          }

          if (bytesRead == 0) {
            if (length == 0) {
              return done(null);
            }
            return FileUtil.fail("EOF", done);
          }

          if (length >= 0) {
            length -= bytesRead;
          }
          fromPosition += bytesRead;

          fs.write(th, buffer, 0, bytesRead, toPosition, (err) => {
            if (err) {
              return done(err);
            }

            toPosition += bytesRead;
            copy();
          });
        },
      );
    }
  }

  fhash(
    handle: number,
    alg: string,
    position: number,
    length: number,
    blockSize: number,
    callback: (err: Error, hashes: Buffer, alg: string) => any,
  ): void {
    //TODO: add argument checks
    //TODO: make sure the behavior (such as optional length or multiple algs) follows the spec
    //TODO: handle very long block sizes properly

    if (/@sftp.ws$/.test(alg)) {
      // specify "alg@sftp.ws" to request non-standard algorithms
      alg = alg.substring(0, alg.length - 8);
    } else {
      switch (alg) {
        case "md5":
        case "sha1":
        case "sha224":
        case "sha256":
        case "sha384":
        case "sha512":
        case "crc32":
          // defined by draft-ietf-secsh-filexfer-extensions-00
          break;
        default:
          // unknown algorithm
          alg = "";
          break;
      }
    }

    // determine hash size
    let hashSize = alg ? _hashSizes[alg] : 0;
    if (typeof hashSize === "undefined" && alg) {
      let hasher;
      try {
        hasher = crypto.createHash(alg);
      } catch (err) {
        hasher = null;
      }
      if (hasher == null) {
        hashSize = 0;
      } else {
        hashSize = hasher.digest().length + 0;
      }
      _hashSizes[alg] = hashSize;
    }

    if (hashSize <= 0 || hashSize > 64) {
      return FileUtil.fail("Unsupported hash algorithm", callback);
    }

    // calculate block count
    const count = ((length + blockSize - 1) / blockSize) | 0;

    // prepare buffers
    const block = Buffer.alloc(blockSize);
    const hashes = Buffer.alloc(count * hashSize);
    let hashesOffset = 0;

    const fs = this.fs;

    this._execute(
      handle,
      (handle, callback) => {
        next();

        function next() {
          let bytesToRead = Math.min(blockSize, length);

          if (bytesToRead == 0) {
            return callback(null, hashes.slice(0, hashesOffset), alg);
          }

          fs.read(
            handle,
            block,
            0,
            bytesToRead,
            position,
            (err, _b, bytesRead) => {
              if (err) {
                return callback(err, null, alg);
              }

              //TODO: when we got incomplete data, read again (the functionality is already
              // in fs-local and should be moved to fs-safe)

              // make sure we got the requested data
              if (bytesRead != bytesToRead) {
                return callback(new Error("Unable to read data"), null, alg);
              }

              position += bytesRead;
              length -= bytesRead;

              // calculate hash
              const hasher = crypto.createHash(alg);
              hasher.update(block.slice(0, bytesRead));
              const hash = hasher.digest();

              // copy hash to results
              hash.copy(hashes, hashesOffset);
              hashesOffset += hashSize;

              next();
            },
          );
        }
      },
      callback,
    );
  }
}
