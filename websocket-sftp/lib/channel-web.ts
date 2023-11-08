import {
  AbstractWebSocketChannelFactory,
  WebSocketChannel,
  ChannelCreateResult,
  type MessagePreprocFn,
  type ConnectCallback,
  type CloseEventHandler,
} from "./channel";
import { SftpError } from "./util";

export class WebSocketChannelFactoryWeb extends AbstractWebSocketChannelFactory<WebSocket> {
  prepareConnection(address: string): string {
    return address;
  }

  createChannel(address: string, options: Record<string, any>): ChannelCreateResult<WebSocket> {
    // does anyone *really* pass subprotocols here?
    const protocols = options?.protocol ? [options.protocol] : undefined;
    const webSocket = new WebSocket(address, protocols);
    const channel = new WebSocketChannelWeb(webSocket, true, false);
    return {webSocket, channel, options};
  }

  bindEventListeners(result: ChannelCreateResult<WebSocket>, callback: ConnectCallback): void {
    const { webSocket } = result;
    const channel = result.channel as WebSocketChannelWeb;

    webSocket.addEventListener("open", () => {
      channel._init();
      callback(null);
    });

    channel.on("close", (err: SftpError | null) => {
      callback(err ?? new Error("Connection closed"));
    });
  }

  createBoundChannel(ws: WebSocket) {
    return new WebSocketChannelWeb(ws, true, true);
  }
}


class WebSocketChannelWeb extends WebSocketChannel<WebSocket> {
  private failed: boolean = false;

  constructor(ws: WebSocket, binary: boolean, established: boolean) {
    super(ws, binary, established);

    ws.addEventListener("error", _err => {
      // seems that the error message is dropped
      this.failed = true;
    });
  }

  protected bindMessageListener(preproc: MessagePreprocFn, listener: (packet: Uint8Array) => void): void {
    this.ws.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      let data = event.data;
      const isBinary = data instanceof ArrayBuffer;
      if (preproc(data, isBinary) === false) return;

      let packet: Uint8Array;
      try {
        packet = WebSocketChannel.validateMessage(data, isBinary);
      } catch (err) {
        this._close(1, err);
        return;
      }
      listener(packet);
    })
  }

  protected interpretCloseStatus(code: number, reason: string): number | [string, string] {
    if (code === 1006 && this.failed) {
      return ["ECONNREFUSED", "Connection refused"];
    }
    if (code === 1011) {
      return ["ECONNRESET", "Connection reset"];
    }
    return super.interpretCloseStatus(code, reason);
  }

  doSend(p: Uint8Array) {
    this.ws.send(p);
  }

  protected bindCloseListener(listener: CloseEventHandler): void {
    this.ws.addEventListener("close", evt => {
      listener(evt)
    });
  }

  doClose(reason: number, description: string): void {
    this.ws.close(reason, description);
  }
}
