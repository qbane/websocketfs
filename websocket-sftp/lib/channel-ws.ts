import { WebSocketWS, type WS } from "./compat";
import {
  AbstractWebSocketChannelFactory,
  WebSocketChannel,
  ChannelCreateResult,
  type ConnectCallback,
  type MessagePreprocFn,
  type CloseEventHandler,
} from "./channel";
import { SftpError } from "./util";
import Url from "node:url";

export class WebSocketChannelFactoryWS extends AbstractWebSocketChannelFactory<WS> {
  prepareConnection(address: string, options: Record<string, any>): string {
    const url = Url.parse(address);
    options.username = url.auth || options.username;
    options.password = options.password || options.passphrase;
    url.auth = null;
    return Url.format(url);
  }

  createChannel(address: string, options: Record<string, any>, _credentials: string): ChannelCreateResult<WS> {
    // TODO: write credentials into options, and then create
    const webSocket = new WebSocketWS!(address, {...options});
    const channel = new WebSocketChannelWS(webSocket, true, false);
    return {webSocket, channel, options};
  }

  bindEventListeners(result: ChannelCreateResult<WS>, callback: ConnectCallback): void {
    const { webSocket, options } = result;
    const channel = result.channel as WebSocketChannelWS;
    const hasAuthHeader = options.headers?.Authorization != null;
    let shouldTryAuthNext = false;

    webSocket.on("open", () => {
      channel._init();
      callback(null);
    });
    webSocket.on("unexpected-response", (req, res) => {
      req.abort();
      const information = res.headers["sftp-authenticate-info"];
      let message: string;
      let code = "X_NOWS";
      if (res.statusCode === 200) {
        message = "Unable to upgrade to WebSocket protocol";
      } else if (res.statusCode === 401) {
        code = "X_NOAUTH";
        if (!hasAuthHeader) {
          for (var i = 0; i < res.rawHeaders.length; i += 2) {
            if (!res.rawHeaders[i].match(/^WWW-Authenticate$/i)) continue;
            if (!res.rawHeaders[i + 1].match(/^Basic realm/)) continue;

            shouldTryAuthNext = true;
            break;
          }
          message = "Authentication required";
        } else {
          message = "Authentication failed";
        }
      } else {
        message = "Unexpected server response: '" + res.statusCode + " " + res.statusMessage + "'";
      }

      const err: SftpError = new Error(message) as SftpError;
      err.code = code;
      // err.errno = parseInt(code, 10);
      err.level = "http";
      if (information) (err as any).info = information;

      channel._close(2, err);
    });

    channel.on("close", (err: SftpError | null) => {
      if (err == null) {
        err = new Error("Connection closed");
      }

      if (err.code === "X_NOAUTH" && shouldTryAuthNext && (typeof options.authenticate === "function")) {
        // TODO
      }

      callback(err);
    });
  }

  createBoundChannel(ws: WS) {
    return new WebSocketChannelWS(ws, true, true);
  }
}

class WebSocketChannelWS extends WebSocketChannel<WS> {
  constructor(ws: WS, binary: boolean, established: boolean) {
    super(ws, binary, established);
    this.options = { binary };

    ws.on("error", (err: any) => {
      const code = err.code;

      switch (code) {
        case "HPE_INVALID_CONSTANT":
          err.message = "Server uses invalid protocol";
          err.level = "http";
          break;
        case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
          err.message =
            "Unable to verify leaf certificate (possibly due to missing intermediate CA certificate)";
          err.level = "ssl";
          break;
      }

      if (typeof err.code !== "undefined" && typeof err.errno === "undefined") {
        err.errno = code;
      }

      this._close(0, err);
    });
  }

  protected bindMessageListener(preproc: MessagePreprocFn, listener: (data: ArrayBuffer) => void): void {
    this.ws.on("message", (data: ArrayBuffer, isBinary: boolean) => {
      if (preproc(data, isBinary) === false) return;

      try {
        WebSocketChannel.validateMessage(data, isBinary);
      } catch (err) {
        this._close(1, err);
        return;
      }
      listener(data);
    });
  }

  doSend(payload: Uint8Array): void {
    this.ws.send(payload, this.options, (err) => {
      if (err) this._close(3, err);
    });
  }

  protected bindCloseListener(handler: CloseEventHandler): void {
    this.ws.addEventListener("close", handler);
  }

  doClose(reason: number, description: Buffer): void {
    this.ws.close(reason, description);
  }
}
