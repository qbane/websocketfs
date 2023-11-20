import { EventEmitter } from "node:events";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, ServerOptions as WebSocketIServerOptions } from "ws";
import debug from "debug";
import { IFilesystem } from "./fs-api";
import * as util from "./util";
import * as local from "./fs-local";
import { SafeFilesystem } from "./fs-safe";
import { SftpServerSession } from "./sftp-server";
import { WebSocketChannelFactoryWS } from "./channel-ws";

const log = debug("websocketfs:sftp-server-impl");

export interface IServerOptions extends WebSocketIServerOptions {
  filesystem?: IFilesystem;
  virtualRoot?: string;
  readOnly?: boolean;
  hideUidGid?: boolean;

  log?: util.ILogWriter | any;

  // use a provided WebSocketServer instead of the one created with the options below.
  wss?: WebSocketServer;

  // options for WebSocket server
  noServer?: boolean;
  host?: string;
  port?: number;
  server?: http.Server;
  handleProtocols?: any;
  path?: string;
  disableHixie?: boolean;
  clientTracking?: boolean;
}

export class Server extends EventEmitter {
  private _wss?: WebSocketServer;
  private _sessionInfo: IServerOptions;
  private _log: util.ILogWriter;

  static upgradeReqs: WeakMap<WebSocket, http.IncomingMessage> = new WeakMap();

  constructor(options?: IServerOptions) {
    super();

    options = options || {};
    const serverOptions: WebSocketIServerOptions = {};

    let virtualRoot = options.virtualRoot;
    let filesystem = options.filesystem;
    this._log = util.LogHelper.toLogWriter(options.log);
    const { noServer, wss } = options;

    // FIXME
    (serverOptions.handleProtocols as any) = this.handleProtocols;

    for (const option in options) {
      if (options.hasOwnProperty(option)) {
        switch (option) {
          case "filesystem":
          case "virtualRoot":
          case "readOnly":
          case "hideUidGid":
          case "log":
            break;
          default:
            serverOptions[option] = options[option];
            break;
        }
      }
    }

    if (typeof virtualRoot === "undefined") {
      virtualRoot = process.cwd();
    } else {
      virtualRoot = path.resolve(virtualRoot);
    }

    if (typeof filesystem === "undefined") {
      filesystem = new local.LocalFilesystem();
    }

    this._sessionInfo = {
      filesystem,
      virtualRoot,
      readOnly: true && options.readOnly,
      hideUidGid: true && options.hideUidGid,
    };

    if (!noServer) {
      log("Creating WebSocketServer");
      this._wss = wss ?? new WebSocketServer(serverOptions);
      this._wss.on("error", console.error);
      this._wss.on("connection", (ws: WebSocket, upgradeReq) => {
        log("WebSocketServer received a new connection");
        Server.upgradeReqs.set(ws, upgradeReq);
        ws.binaryType = "arraybuffer";
        this.accept(ws, (err, _session) => {
          if (err) {
            log("WebSocketServer: error while accepting connection", err);
          } else {
            log("WebSocketServer: accept connection and created session");
          }
        });
      });
      log("SFTP server started");
    }
  }

  private handleProtocols(
    protocols: string[],
    callback: (result: boolean, protocol?: string) => void,
  ): void {
    for (let i = 0; i < protocols.length; i++) {
      const protocol = protocols[i];
      switch (protocol) {
        case "sftp":
          callback(true, protocol);
          return;
      }
    }

    callback(false);
  }

  end() {
    if (this._wss != null) {
      const count = this._wss.clients.size;
      if (count > 0) {
        this._log.debug("Stopping %d SFTP sessions ...", count);

        // end all active sessions
        for (const ws of this._wss.clients) {
          const session = <SftpServerSession>(<any>ws).session;
          if (typeof session === "object") {
            session.end();
            delete (<any>ws).session;
          }
        }
      }

      // stop accepting connections
      this._wss.close();
      delete this._wss;

      this._log.info("SFTP server stopped");
    }
  }

  accept(
    ws: WebSocket,
    callback?: (err: Error | null, session?: SftpServerSession) => void,
  ): void {
    try {
      const sessionInfo = this._sessionInfo;
      log("accept", sessionInfo);

      let virtualRoot = sessionInfo.virtualRoot;
      if (virtualRoot == null) {
        throw Error("virtualRoot must not be null");
      }
      if (sessionInfo.filesystem == null) {
        throw Error("sessionInfo.filesystem must not be null");
      }

      const fs = new SafeFilesystem(
        sessionInfo.filesystem,
        virtualRoot,
        sessionInfo,
      );

      const factory = new WebSocketChannelFactoryWS();
      const channel = factory.bind(ws as any);

      const socket = Server.upgradeReqs.get(ws)!.connection;
      const info = {
        clientAddress: socket.remoteAddress,
        clientPort: socket.remotePort,
        clientFamily: socket.remoteFamily,
        serverAddress: socket.localAddress,
        serverPort: socket.localPort,
      };

      const session = new SftpServerSession(
        channel,
        fs,
        this,
        this._log,
        info,
      );
      this.emit("startedSession", this);
      (<any>ws).session = session;
      callback?.(null, session);
    } catch (err) {
      callback?.(err);
    }
  }
}
