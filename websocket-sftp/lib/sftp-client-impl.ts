import type { Agent } from "node:http";
import { BROWSER } from "esm-env";
import debug from "debug";
import { SftpClient, ISftpClientEvents } from "./sftp-client";
import { Task } from "./fs-plus";
import { WebSocketChannelFactoryWS } from "./channel-ws";
import { WebSocketChannelFactoryWeb } from "./channel-web";
import * as util from "./util";

const WebSocketChannelFactory = BROWSER ? WebSocketChannelFactoryWeb : WebSocketChannelFactoryWS;

const log = debug("websocketfs:sftp-client-impl");

export interface IClientOptions {
  log?: util.ILogWriter | any;
  protocol?: string;
  promise?: Function;
  agent?: Agent;
  headers?: { [key: string]: string };
  protocolVersion?: any;
  host?: string;
}

export class Client extends SftpClient implements ISftpClientEvents<Client> {
  // hint: In Node's setup, a local fs can be passed to the parent class
  // constructor(localFs?: local.LocalFilesystem) {}

  on(event: string, listener) {
    return super.on(event, listener);
  }

  once(event: string, listener) {
    return super.once(event, listener);
  }

  connect(
    address: string,
    options?: IClientOptions,
    callback?: (err: Error | null) => void,
  ): Task<void> {
    log("Client.connect", address, options);
    if (typeof callback === "undefined" && typeof options === "function") {
      callback = <any>options;
      options = undefined;
    }

    return super._task(callback, (callback) => {
      options = options ?? {};

      if (options.protocol == null) {
        options.protocol = "sftp";
      }

      log("Client.connect: connect factory...");
      const factory = new WebSocketChannelFactory();
      factory.connect(address, options, (err, channel) => {
        if (err) {
          log("Client.connect WebSocketChannelFactory, failed ", err);
          return callback(err);
        }
        if (channel == null) {
          throw Error("bug");
        }
        log("Client.connect WebSocketChannelFactory, connected");

        super._bind(channel, options, callback);
      });
    });
  }
}
