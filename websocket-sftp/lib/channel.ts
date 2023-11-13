import debug from "debug";
import { IWebSocket, type WS } from "./compat";
import { SftpError } from "./util";

const log = debug("websocketfs:channel");

export interface ChannelCreateResult<T extends IWebSocket> {
  webSocket: T;
  channel: WebSocketChannel<T>;
  options: Record<string, any>;
  [key: string]: any;
};

export type MessagePreprocFn = (data: any, isBinary: boolean) => false | void;
export type ConnectCallback = (err: SftpError | null, channel?: IChannel) => any;
export type CloseEventHandler = (evt: Omit<WS.CloseEvent, "target">) => void;

export interface IChannel {
  on(event: string, listener: Function): IChannel;
  send(packet: Uint8Array): void;
  close(reason?: CloseReason | number, description?: string): void;
}

export const enum CloseReason {
  NORMAL = 1000, // Normal closure; the connection successfully completed whatever purpose for which it was created.
  GOING_AWAY = 1001, // The endpoint is going away, either because of a server failure or because the browser is navigating away from the page that opened the connection.
  PROTOCOL_ERROR = 1002, // The endpoint is terminating the connection due to a protocol error.
  UNSUPPORTED = 1003, // The connection is being terminated because the endpoint received data of a type it cannot accept (for example, a text-only endpoint received binary data).
  NO_STATUS = 1005, // Indicates that no status code was provided even though one was expected.
  ABNORMAL = 1006, // Used to indicate that a connection was closed abnormally (that is, with no close frame being sent) when a status code is expected.
  BAD_DATA = 1007, // The endpoint is terminating the connection because a message was received that contained inconsistent data (e.g., non-UTF-8 data within a text message).
  POLICY_VIOLATION = 1008, // The endpoint is terminating the connection because it received a message that violates its policy.This is a generic status code, used when codes 1003 and 1009 are not suitable.
  TOO_LARGE = 1009, // The endpoint is terminating the connection because a data frame was received that is too large.
  NO_EXTENSIONS_NEGOTIATED = 1010, // The client is terminating the connection because it expected the server to negotiate one or more extension, but the server didn't.
  UNEXPECTED_CONDITION = 1011, // The server is terminating the connection because it encountered an unexpected condition that prevented it from fulfilling the request.
  FAILED_TLS_HANDSHAKE = 1015, // Indicates that the connection was closed due to a failure to perform a TLS handshake (e.g., the server certificate can't be verified).
}

export abstract class AbstractWebSocketChannelFactory<T extends IWebSocket> {
  protected abstract prepareConnection(address: string, options: Record<string, any>): string;
  protected abstract createChannel(
    address: string,
    options: Record<string, any>,
    credentials: string): ChannelCreateResult<T>;
  protected abstract bindEventListeners(createResult: ChannelCreateResult<T>, callback: ConnectCallback): void;

  connect(
    address: string,
    options: Record<string, any>,
    callback: ConnectCallback,
  ): void {
    log("connect", address, options);

    const url = this.prepareConnection(address, options);
    this._connect(url, options, "")
      .then(ch => callback(null, ch))
      .catch(err => callback(err));
  }

  protected _connect(
    address: string,
    options: Record<string, any>,
    credentials: string): Promise<IChannel> {
    log("_connect", address, options);

    const createResult = this.createChannel(address, options, credentials);
    createResult.webSocket.binaryType = "arraybuffer";

    return new Promise((resolve, reject) => {
      this.bindEventListeners(createResult, err => {
        err ? reject(err) : resolve(createResult.channel);
      });
    });
  }

  bind(ws: T): IChannel {
    if (ws.readyState != ws.OPEN) {
      throw new Error("WebSocket is not open");
    }
    return this.createBoundChannel(ws);
  }

  protected abstract createBoundChannel(ws: T): IChannel;
}


/*
TODO: Weirdness warning!  This WebSocketChannel is NOT an event emitter.  When
something does .on(event) it steals the listener.  It's very weird.
*/

export abstract class WebSocketChannel<T extends IWebSocket> implements IChannel {
  protected ws: T;
  protected options: any;
  protected established: boolean;
  protected closed: boolean;
  protected onclose: ((err: SftpError) => void) | null;

  constructor(ws: T, _binary: boolean, established: boolean) {
    this.ws = ws;
    this.established = established;
    this._bindCloseListener();
  }

  _init(): void {
    this.onclose = null;
    this.established = true;
  }

  on(event: string, listener: any): IChannel {
    switch (event) {
      case "message":
        this._bindMessageListener(listener);
        break;
      case "close":
        this.onclose = listener;
        break;
      default:
        break;
    }
    return this;
  }

  protected static validateMessage(data: any, isBinary: boolean): ArrayBuffer {
    if (isBinary) {
      if (data instanceof ArrayBuffer) {
        return data;
      }
      throw new SftpError("Received a binary message with unsupported data type.");
    } else {
      throw new SftpError(
        "Connection failed due to unsupported packet type -- all messages must be binary",
        { code: "EFAILURE", errno: -38, level: "ws" },
      );
    }
  }

  private _bindMessageListener(listener: any): void {
    const preproc: MessagePreprocFn = (data: ArrayBuffer, isBinary: boolean) => {
      if (this.closed) return false;
      log("received message", { data, isBinary });
    };
    this.bindMessageListener(preproc, listener);
  }

  protected abstract bindMessageListener(preproc: MessagePreprocFn, listener: (data: ArrayBuffer) => void): void;

  private _bindCloseListener() {
    this.bindCloseListener(evt => {
      const { code, reason } = evt;
      log("WebSocketChannel: ws.on.close", reason);
      const mapped = this.interpretCloseStatus(code, reason);
      let message: string = "", errstr: string = "";
      if (typeof mapped === "number") {
        // not an error
        this._close(mapped, null);
      } else {
        [errstr, message] = mapped;
        const err: SftpError = new Error(message);
        // err.errno = errstr;  // WTF?
        err.code = errstr;
        err.level = "ws";
        (err as any).nativeCode = code;
        this._close(code, err);
      }
    })
  }

  protected abstract bindCloseListener(listener: CloseEventHandler): void;

  protected interpretCloseStatus(code: number, reason: string): number | [string, string] {
    let message: string = "Connection failed";

    switch (code) {
    case 1000:
      return code;
    case 1001:
      return ["X_GOINGAWAY", "Endpoint is going away"];
    case 1002:
      return ["EPROTOTYPE", "Protocol error"];
    case 1006:
      return ["ECONNABORTED", "Connection aborted"];
    case 1007:
      message = "Invalid message";
      break;
    case 1008:
      message = "Prohibited message";
      break;
    case 1009:
      message = "Message too large";
      break;
    case 1010:
      return ["ECONNRESET", "Connection terminated"];
    case 1011:
      return ["ECONNRESET", reason];
    case 1015:
      return ["EFAILURE", "Unable to negotiate secure connection"];
    }
    return ["EFAILURE", message];
  }

  _close(_kind: number, err: SftpError | null): void {
    if (this.closed) return;
    const onclose = this.onclose;
    this.close();

    if (!err && !this.established) {
      err = new Error("Connection refused");
      // err.errno WTF
      err.code = "ECONNREFUSED";
    }

    // FIXME: err may be null
    if (typeof onclose === "function") {
      process.nextTick(() => {
        onclose(err!)
      });
    } else {
      if (err) {
        throw err;
      }
    }
  }

  send(packet: Uint8Array): void {
    if (this.closed) return;

    try {
      this.doSend(packet);
    } catch (err) {
      this._close(2, err);
    }
  }

  protected abstract doSend(packet: Uint8Array): void;

  close(reason?: number, description?: string): void {
    if (this.closed) return;
    this.closed = true;

    this.onclose = null;
    this.bindMessageListener = () => {};
    // this.onmessage = null;

    if (!reason) reason = 1000;
    try {
      this.doClose(reason, description);
    } catch (err) {
      // ignore errors - we are shuting down the socket anyway
    }
  }

  protected abstract doClose(reason: number, description: any): void;
}
