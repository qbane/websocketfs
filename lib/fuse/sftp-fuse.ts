import { Client as SftpClient } from "../sftp/sftp";
import { callback } from "awaiting";
import { bindMethods } from "./util";
import Fuse from "fuse-native";

import debug from "debug";

const log = debug("websocketfs:fuse:sftp");

// https://libfuse.github.io/doxygen/structfuse__operations.html
// https://github.com/direktspeed/node-fuse-bindings

export default class SftpFuse {
  private remote: string;
  private sftp: SftpClient;

  constructor(remote: string) {
    this.remote = remote;
    this.sftp = new SftpClient();
    bindMethods(this.sftp);
    bindMethods(this);
  }

  async connect() {
    log("connecting to ", this.remote);
    await callback(this.sftp.connect, this.remote, {});
  }

  init(cb) {
    log("Filesystem init");
    cb(0);
  }

  access(path: string, mode: number, cb) {
    log("access", path, mode);
    // TODO
    cb(0);
  }

  statfs(path: string, cb) {
    // this gets called when you do "df" on the mountpoint.
    log("statfs: TODO", path);
    cb(0, {});
  }

  async getattr(path: string, cb) {
    log("getattr", path);
    try {
      const stats = await callback(this.sftp.lstat, path);
      cb(undefined, stats);
    } catch (err) {
      log("getattr error ", err);
      cb(Fuse[err.code]);
    }
  }

  fgetattr(path: string, _fd: number, cb) {
    log("fgetattr", path);
    this.getattr(path, cb);
  }

  flush(path: string, _fd: number, cb) {
    log("flush", path);
    // TODO: this will impact caching...?
    cb(0);
  }

  fsync(path: string, _fd: number, _datasync, cb) {
    log("fsync", path);
    cb(0);
  }

  fsyncdir(path: string, _fd: number, _datasync, cb) {
    log("fsyncdir", path);
    cb(0);
  }

  async readdir(path: string, cb) {
    log("readdir", path);
    try {
      const handle = await callback(this.sftp.opendir, path);
      log("readdir - opendir got a handle", handle._handle);
      const items = await callback(this.sftp.readdir, handle);
      log("readdir - items", items);
      // todo: cache attrs from items (?)
      if (typeof items == "boolean") {
        throw Error("readdir fail");
      }
      cb(
        0,
        items.map(({ filename }) => filename)
      );
      return items;
    } catch (err) {
      log("readdir - error", err);
      cb(err);
    }
  }
}
