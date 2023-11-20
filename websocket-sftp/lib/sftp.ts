import * as local from "./fs-local";
import * as api from "./fs-api";
import { IChannel as IChannel0 } from "./channel";
import * as channel_stream from "./channel-stream";
import { WebSocketChannelFactoryWS } from "./channel-ws";
import * as util from "./util";

export interface IStats extends api.IStats {}
export interface IItem extends api.IItem {}
export interface IFilesystem extends api.IFilesystem {}
export interface ILogWriter extends util.ILogWriter {}

export enum RenameFlags {
  OVERWRITE = <number>api.RenameFlags.OVERWRITE,
}

export const LocalFilesystem = local.LocalFilesystem;

export interface IChannel extends IChannel0 {}

export module Internals {
  export const StreamChannel = channel_stream.StreamChannel;
  export const WebSocketChannelFactory = WebSocketChannelFactoryWS;
  export const LogHelper = util.LogHelper;
}

export { Server } from "./sftp-server-impl";
export type { IServerOptions } from "./sftp-server-impl";

export { Client } from "./sftp-client-impl";
export type { IClientOptions } from "./sftp-client-impl";
