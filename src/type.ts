export type PageType = 'main' | 'iframe';
export type MessageType = 'register' | 'message' | string;

export interface IframeBridgeOptions {
  iframeId?: string;
  origin?: string;
  originWhitelist?: string[] | undefined; // undefined 表示不启用白名单校验
  type?: PageType;
  lifecycle?: {
    autoDestroy?: boolean;
  };
}



export interface IframeMessage {
  type?: MessageType;
  key?: string;
  sourceId?: string;
  targetId?: string;
  origin?: string;
  path?: string[];
  data?: unknown; // 存放编码后的数据（base64字符串）
  encoded?: boolean; // 数据是否经过编码
  timestamp?: number;
}

export interface MessageEventData extends IframeMessage {
  // 用于传递 event.source 时在注册流程中保留
  source?: WindowProxy | null;
}
