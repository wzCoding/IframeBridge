export interface IframeBridgeOptions {
    iframeId: string
    origin?: string
    originWhiteList?: string[]
    type?: 'main' | 'iframe'
    encodeFn: EncodeFn
    decodeFn: DecodeFn
}

export interface EncodeFn {
    (payload: unknown): string | object | Promise<string | object>
}

export interface DecodeFn {
    (encode: unknown, meta?: { origin?: string, sourceWindow?: Window | null }): unknown | Promise<unknown>
}

export interface IframeMessage {
    type: 'register' | 'message'
    key: string
    sourceId: string
    targetId: string
    origin: string
    path: string[]
    data: unknown
    timestamp: number
    _origin?: string
    _sourceWindow?: Window | null
}