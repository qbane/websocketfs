import { BROWSER } from "esm-env";

const _EventEmitterNode =
  () => import("node:events").then(mod => mod.EventEmitter);
const _EE3 =
  () => import("eventemitter3").then(mod => mod.EventEmitter);

export interface IEventEmitter {
  on(event: string, fn: Function): this;
  once(event: string, fn: Function): this;
  emit(event: string, ...args: any[]): boolean;
  listeners(event: string): Function[];
  listenerCount(event: string): number;
}

export const EventEmitter: new (options?: {}) => IEventEmitter =
  await (BROWSER ? _EE3 : _EventEmitterNode)();

import type WS from "ws";
export type { WS };

export type WebSocketWSClass = new (...args: any[]) => WS;

const _WebSocketWS = () => import("ws").then(mod => mod.WebSocket);

export const WebSocketWS: null | WebSocketWSClass =
  BROWSER ? null : await (_WebSocketWS());

export interface IWebSocket {
  binaryType: string;
  readonly readyState: number;
  readonly OPEN: typeof WS.OPEN;
};
