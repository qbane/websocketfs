import { IEventEmitter, EventEmitter } from "./compat";
import { IFilesystem, IItem, IStats, RenameFlags } from "./fs-api";
import {
  IDataSource,
  IDataTarget,
  FileUtil,
  Path,
} from "./fs-misc";
import { FileDataSource, toDataSource } from "./fs-sources";
import {
  FileDataTarget,
  StringDataTarget,
  BufferDataTarget,
} from "./fs-targets";
import { search, ISearchOptionsExt, ISearchOptions } from "./fs-glob";
import type { SftpHandle } from "./sftp-client";

export interface Task<T> extends Promise<T> {
  on(event: string, listener: Function): Task<T>;
  once(event: string, listener: Function): Task<T>;
}

interface PathToExists {
  [path: string]: boolean;
}

export interface IFilesystemExt extends FilesystemPlus {}

export class FilesystemPlus extends EventEmitter implements IFilesystem {
  protected _fs: IFilesystem;
  protected _local: IFilesystem;

  constructor(fs: IFilesystem, local?: IFilesystem) {
    super();
    this._fs = fs;
    this._local = local as IFilesystem;
  }

  open(
    path: string,
    flags: string | number,
    attrs?: IStats,
    callback?: (err: Error, handle: SftpHandle) => void,
  ): Task<any> {
    if (typeof callback === "undefined" && typeof attrs === "function") {
      callback = <any>attrs;
      attrs = undefined;
    }

    return this._task(callback, (callback) => {
      this._fs.open(path, flags, attrs, callback);
    });
  }

  close(handle: any, callback?: (err: Error) => any): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.close(handle, callback);
    });
  }

  read(
    handle: any,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback?: (err: Error, buffer: Buffer, bytesRead: number) => any,
  ): Task<Buffer> {
    return this._task(callback, (callback) => {
      this._fs.read(handle, buffer, offset, length, position, callback);
    });
  }

  fhash(
    handle: any,
    alg: string,
    position: number,
    length: number,
    blockSize: number,
    callback?: (err: Error, hashes: Buffer, alg: string) => any,
  ): Task<Buffer> {
    return this._task(callback, (callback) => {
      if (this._fs.fhash == null) {
        callback(Error("fhash not supported"));
        return;
      }
      this._fs.fhash(handle, alg, position, length, blockSize, callback);
    });
  }

  fcopy(
    fromHandle: any,
    fromPosition: number,
    length: number,
    toHandle: any,
    toPosition: number,
    callback: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      if (this._fs.fcopy == null) {
        callback(Error("fcopy not supported"));
        return;
      }
      this._fs.fcopy(
        fromHandle,
        fromPosition,
        length,
        toHandle,
        toPosition,
        callback,
      );
    });
  }

  write(
    handle: any,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.write(handle, buffer, offset, length, position, callback);
    });
  }

  lstat(
    path: string,
    callback?: (err: Error, attrs: IStats) => any,
  ): Task<IStats> {
    return this._task(callback, (callback) => {
      this._fs.lstat(path, callback);
    });
  }

  fstat(
    handle: any,
    callback?: (err: Error, attrs: IStats) => any,
  ): Task<IStats> {
    return this._task(callback, (callback) => {
      this._fs.fstat(handle, callback);
    });
  }

  setstat(
    path: string,
    attrs: IStats,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.setstat(path, attrs, callback);
    });
  }

  fsetstat(
    handle: any,
    attrs: IStats,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.fsetstat(handle, attrs, callback);
    });
  }

  opendir(
    path: string,
    callback?: (err: Error, handle: any) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.opendir(path, callback);
    });
  }

  readdir(
    path: string,
    callback?: (err: Error, items: IItem[] | false) => any,
  ): Task<IItem[]>;
  readdir(
    handle: any,
    callback?: (err: Error, items: IItem[] | false) => any,
  ): Task<IItem[] | boolean>;
  readdir(
    handle: any,
    callback?: (err: Error, items: IItem[] | false) => any,
  ): Task<IItem[] | boolean> {
    return this._task(callback, (callback) => {
      if (typeof handle === "string") {
        const path = Path.check(<string>handle, "path");
        FileUtil.list(this._fs, path, true, callback);
        return;
      }

      this._fs.readdir(handle, callback);
    });
  }

  unlink(path: string, callback?: (err: Error) => any): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.unlink(path, callback);
    });
  }

  mkdir(
    path: string,
    attrs?: IStats,
    callback?: (err: Error) => any,
  ): Task<void> {
    if (typeof callback === "undefined" && typeof attrs === "function") {
      callback = <any>attrs;
      attrs = undefined;
    }

    return this._task(callback, (callback) => {
      this._fs.mkdir(path, attrs, callback);
    });
  }

  rmdir(path: string, callback?: (err: Error) => any): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.rmdir(path, callback);
    });
  }

  realpath(
    path: string,
    callback?: (err: Error, resolvedPath: string) => any,
  ): Task<string> {
    return this._task(callback, (callback) => {
      this._fs.realpath(path, callback);
    });
  }

  stat(
    path: string,
    callback?: (err: Error, attrs: IStats) => any,
  ): Task<IStats> {
    return this._task(callback, (callback) => {
      this._fs.stat(path, callback);
    });
  }

  statvfs(path: string, callback?: (err: Error, stats) => any): Task<any> {
    return this._task(callback, (callback) => {
      this._fs.statvfs(path, callback);
    });
  }

  rename(
    oldPath: string,
    newPath: string,
    callback?: (err: Error) => any,
  ): Task<void>;
  rename(
    oldPath: string,
    newPath: string,
    overwrite: boolean,
    callback?: (err: Error) => any,
  ): Task<void>;
  rename(
    oldPath: string,
    newPath: string,
    flags: RenameFlags,
    callback?: (err: Error) => any,
  ): Task<void>;
  rename(
    oldPath: string,
    newPath: string,
    flags: any,
    callback?: (err: Error) => any,
  ): Task<void> {
    if (typeof callback === "undefined" && typeof flags === "function") {
      callback = flags;
      flags = 0;
    } else {
      flags |= 0;
    }

    return this._task(callback, (callback) => {
      this._fs.rename(oldPath, newPath, flags, callback);
    });
  }

  readlink(
    path: string,
    callback?: (err: Error, linkString: string) => any,
  ): Task<string> {
    return this._task(callback, (callback) => {
      this._fs.readlink(path, callback);
    });
  }

  symlink(
    oldPath: string,
    newPath: string,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.symlink(oldPath, newPath, callback);
    });
  }

  join(..._paths: string[]): string {
    const path = new Path("", this._fs);
    return path.join.apply(path, arguments).normalize().path;
  }

  link(
    oldPath: string,
    newPath: string,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback) => {
      this._fs.link(oldPath, newPath, callback);
    });
  }

  list(
    remotePath: string,
    callback?: (err: Error, items: IItem[]) => any,
  ): Task<IItem[]> {
    return this._task(callback, (callback, emitter) => {
      remotePath = Path.check(remotePath, "remotePath");

      const options = <ISearchOptionsExt>{
        directories: true,
        files: true,
        nosort: false,
        dotdirs: false,
        noglobstar: true,
        onedir: true,
        all: true,
      };

      search(this._fs, remotePath, emitter, options, callback);
    });
  }

  search(
    remotePath: string,
    options?: ISearchOptions,
    callback?: (err: Error, items: IItem[]) => any,
  ): Task<IItem[]> {
    if (typeof callback === "undefined" && typeof options === "function") {
      callback = <any>options;
      options = undefined;
    }

    return this._task(callback, (callback, emitter) => {
      remotePath = Path.check(remotePath, "remotePath");

      search(this._fs, remotePath, emitter, options, callback);
    });
  }

  info(
    remotePath: string,
    callback?: (err: Error | null, item: IItem) => any,
  ): Task<IItem> {
    return this._task(callback, (callback, emitter) => {
      remotePath = Path.check(remotePath, "remotePath");

      const options = <ISearchOptionsExt>{
        oneitem: true,
      };

      search(this._fs, remotePath, emitter, options, (err, items) => {
        if (err) {
          return callback(err, null);
        }
        if (!items || items.length != 1)
          return callback(new Error("Unexpected result"), null);
        callback(null, items[0]);
      });
    });
  }

  readFile(
    remotePath: string,
    options?: {
      type?: string;
      encoding?: string;
      flag?: string;
      mimeType?: string;
    },
    callback?: (err: Error, data: {}) => any,
  ): Task<any> {
    if (typeof callback === "undefined" && typeof options === "function") {
      callback = <any>options;
      options = undefined;
    }

    return this._task(callback, (callback, emitter) => {
      const remote = Path.create(remotePath, this._fs, "remotePath");

      // process options
      options = options ?? {};
      let type = options.type;
      let encoding = options.encoding;
      if (type) {
        type = (type + "").toLowerCase();
        if (type == "string" || type == "text") {
          encoding = encoding ?? "utf8";
        }
      } else {
        type = encoding ? "string" : "buffer";
      }

      // create appropriate target
      let target: IDataTarget;
      switch (type) {
        case "text":
        case "string":
          target = new StringDataTarget(encoding);
          break;
        case "array":
        case "buffer":
          target = new BufferDataTarget();
          break;
        case "blob":
        default:
          throw new Error("Unsupported data kind: " + options.type);
      }

      // create source
      if (remote.fs == null) {
        throw Error("bug");
      }
      const source = new FileDataSource(remote.fs, remote.path);

      // copy file data
      FileUtil.copy(source, target, emitter, (err) => {
        if (err) return callback(err, null);
        callback(null, (<any>target).result());
      });
    });
  }

  putFile(
    localPath: string,
    remotePath: string,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback, emitter) => {
      const local = Path.create(localPath, this._local, "localPath");
      const remote = Path.create(remotePath, this._fs, "remotePath");

      this._copyFile(local, remote, emitter, callback);
    });
  }

  getFile(
    remotePath: string,
    localPath: string,
    callback?: (err: Error) => any,
  ): Task<void> {
    return this._task(callback, (callback, emitter) => {
      const remote = Path.create(remotePath, this._fs, "remotePath");
      const local = Path.create(localPath, this._local, "localPath");

      this._copyFile(remote, local, emitter, callback);
    });
  }

  private _copyFile(
    sourcePath: Path,
    targetPath: Path,
    emitter: IEventEmitter | undefined,
    callback: (err: Error | null, ...args: any[]) => any,
  ): void {
    // append filename if target path ens with slash
    if (targetPath.endsWithSlash()) {
      const filename = sourcePath.getName();
      targetPath = targetPath.join(filename);
    }

    // create source and target
    if (sourcePath.fs == null) {
      throw Error("sourcePath.fs must be defined");
    }
    const source = new FileDataSource(sourcePath.fs, sourcePath.path);
    if (targetPath.fs == null) {
      throw Error("targetPath.fs must be defined");
    }
    const target = new FileDataTarget(targetPath.fs, targetPath.path);

    // copy file data
    FileUtil.copy(source, target, emitter, (err) => callback(err));
  }

  upload(
    localPath: string,
    remotePath: string,
    options?: any,
    callback?: (err: Error) => any,
  ): Task<void>;
  upload(
    input: any,
    remotePath: string,
    options?: any,
    callback?: (err: Error) => any,
  ): Task<void>;
  upload(
    input: any,
    remotePath: string,
    options?: any,
    callback?: (err: Error) => any,
  ): Task<void> {
    if (typeof options === "function" && typeof callback === "undefined") {
      callback = <any>options;
      options = null;
    }

    return this._task(callback, (callback, emitter) => {
      const remote = Path.create(remotePath, this._fs, "remotePath");

      this._copy(input, this._local, remote, options, emitter, callback);
    });
  }

  download(
    remotePath: string | string[],
    localPath: string,
    options?: any,
    callback?: (err: Error) => any,
  ): Task<void> {
    if (typeof options === "function" && typeof callback === "undefined") {
      callback = <any>options;
      options = null;
    }

    return this._task(callback, (callback, emitter) => {
      const local = Path.create(localPath, this._local, "localPath");

      this._copy(remotePath, this._fs, local, options, emitter, callback);
    });
  }

  private _copy(
    from: any,
    fromFs: IFilesystem,
    toPath: Path,
    _options: any,
    emitter: IEventEmitter | undefined,
    callback: (err: Error | null, ...args: any[]) => any,
  ): void {
    let sources: undefined | IDataSource[] = undefined;

    const toFs = toPath.fs;
    if (toFs == null) {
      throw Error("toPath.fs must not be null");
    }
    toPath = toPath.removeTrailingSlash();

    toFs.stat(toPath.path, prepare);

    const directories = <PathToExists>{};

    function prepare(err: Error, stats: IStats): void {
      if (err) return callback(err);

      if (!FileUtil.isDirectory(stats))
        return callback(new Error("Target path is not a directory"));

      try {
        toDataSource(fromFs, from, emitter, (err, src) => {
          if (err) return callback(err);

          try {
            sources = src;
            sources?.forEach((_source) => {
              //TODO: calculate total size
              //TODO: make sure that source.name is valid on target fs
            });

            next();
          } catch (err) {
            callback(err);
          }
        });
      } catch (err) {
        callback(err);
      }
    }

    function next(): void {
      const source = sources?.shift();
      if (!source) {
        return finish();
      }

      let relativePath: Path | null;
      let targetPath: string;
      if (typeof source.relativePath === "string") {
        relativePath = new Path(source.relativePath, fromFs);
        targetPath = toPath.join(relativePath).normalize().path;
        checkParent(relativePath, transfer);
      } else {
        relativePath = null;
        targetPath = toPath.join(source.name).path;
        transfer(null);
      }

      function transfer(err: Error | null): void {
        if (err) {
          return callback(err);
        }
        if (source == null || toFs == null) {
          throw Error("bug");
        }

        if (source.stats != null && FileUtil.isDirectory(source.stats)) {
          FileUtil.mkdir(toFs, targetPath, false, (err, _created) =>
            transferred(err),
          );
        } else {
          const target = new FileDataTarget(toFs, targetPath);
          FileUtil.copy(source, target, emitter, transferred);
        }

        function transferred(err: Error | null): void {
          if (err) {
            return callback(err);
          }
          next();
        }
      }
    }

    function checkParent(path: Path, callback: (err: Error | null) => void) {
      const parent = path.getParent();

      let parentPath = parent.path;
      parentPath = parentPath.length > 0 ? parentPath : "/";

      const exists = directories[parentPath];
      if (exists) {
        return callback(null);
      }

      if (parent.isTop()) return callback(null);

      checkParent(parent, (err) => {
        if (err) {
          return callback(err);
        }

        const targetPath = toPath.join(parent).path;
        if (toFs == null) {
          throw Error("bug");
        }

        try {
          FileUtil.mkdir(toFs, targetPath, false, (err, _created) => {
            if (err) return callback(err);
            directories[targetPath] = true;
            callback(null);
          });
        } catch (err) {
          callback(err);
        }
      });
    }

    function finish(): void {
      return callback(null);
    }
  }

  protected _task<T>(
    callback: undefined | ((err: Error | null, ...args: any[]) => void),
    action: (
      callback: (err: Error | null, ...args: any[]) => void,
      emitter?: IEventEmitter,
    ) => void,
  ): any {
    let emitter;
    if (action.length >= 2) emitter = new EventEmitter();

    if (typeof callback === "function") {
      action(callback, emitter);
      return emitter;
    }

    function on(event: string, listener: Function): Task<T> {
      if (emitter) {
        emitter.on(event, listener);
      }
      return task;
    }

    function once(event: string, listener: Function): Task<T> {
      if (emitter) {
        emitter.on(event, listener);
      }
      return task;
    }

    const that = this;
    function executor(
      resolve: (result: T | Promise<T>) => void,
      reject: (error: Error) => void,
    ): void {
      try {
        action(finish, emitter);
      } catch (err) {
        process.nextTick(() => finish(err));
      }

      function finish(err: Error, ...args: any[]): void;
      function finish(): void {
        const error = arguments[0];
        try {
          if (error) {
            if (emitter) {
              let err = error;
              if (emitter && emitter.listenerCount("error") > 0) {
                emitter.emit("error", err);
                err = null;
              }

              emitter.emit("finish", err);
            }

            reject(error);
          } else {
            if (emitter) {
              switch (arguments.length) {
                case 0:
                case 1:
                  emitter.emit("success");
                  emitter.emit("finish", null);
                  break;
                case 2:
                  emitter.emit("success", arguments[1]);
                  emitter.emit("finish", null, arguments[1]);
                  break;
                case 3:
                  emitter.emit("success", arguments[1], arguments[2]);
                  emitter.emit("finish", null, arguments[1], arguments[2]);
                  break;
                default:
                  arguments[0] = "success";
                  emitter.emit.apply(task, arguments);

                  if (emitter && emitter.listenerCount("finish") > 0) {
                    arguments[0] = "finish";
                    Array.prototype.splice.call(arguments, 1, 0, null);
                    emitter.emit.apply(task, arguments);
                  }
                  break;
              }
            }

            resolve(<T>(<any>arguments[1]));
          }
        } catch (err) {
          that.emit("error", err);
        }
      }
    }

    const task = <any>new Promise(executor);

    task.on = on;
    task.once = once;
    return task;
  }
}
