import { IframeBridgeOptions, IframeMessage, EncodeFn, DecodeFn } from "./type"


/**
 * IframeBridge - 跨 iframe 的消息桥接器
 * 支持主页面与 iframe 页面注册，主页面与 iframe 页面、iframe 页面 与 iframe 页面之间的消息转发、路径追踪、自定义消息加密解密
 */
export class IframeBridge {
    // 公共标识
    public readonly defaultMainPageId = 'main';
    public readonly iframeId: string;
    public readonly origin: string;
    public readonly role: 'main' | 'iframe';

    private encodeFn: EncodeFn | null;
    private decodeFn: DecodeFn | null;

    // 消息回调就绪控制
    private messageCallback: ((msg: IframeMessage) => void) | null = null;
    public readonly messageCallbackReady: Promise<void>;
    private _resolveMessageCallbackReady!: () => void;
    private _messageCallbackReadyResolved = false;

    // 内部状态
    private _msgCounter = 0;
    private registeredIframe: Record<string, { id: string; iframe: HTMLIFrameElement | null; origin: string }> = {};
    private messageQueue: Array<IframeMessage & { _origin?: string; _sourceWindow?: Window | null }> = [];
    private registerQuene: Array<any> = [];
    private isHandleRegister = false;
    private isHandleMessage = false;

    constructor(opts: IframeBridgeOptions = {} as IframeBridgeOptions) {
        const {
            iframeId,
            origin,
            originWhiteList = [],
            type,
            encodeFn,
            decodeFn
        } = opts;
        this.iframeId = iframeId || this.defaultMainPageId;
        this.origin = origin || window.location.origin;
        // role: 外部 type 优先，否则 runtime 检测
        this.role = (type === 'main' || type === 'iframe') ? type : (window.top === window.self ? 'main' : 'iframe');

        this.encodeFn = typeof encodeFn === 'function' ? encodeFn : null;
        this.decodeFn = typeof decodeFn === 'function' ? decodeFn : null;

        // messageCallbackReady promise，确保只 resolve 一次
        this.messageCallbackReady = new Promise<void>((resolve) => {
            this._resolveMessageCallbackReady = () => {
                if (!this._messageCallbackReadyResolved) {
                    this._messageCallbackReadyResolved = true;
                    resolve();
                }
            };
        });

        // 白名单配置：确保包含自身 origin
        if (Array.isArray(originWhiteList) && originWhiteList.length > 0) {
            // 这里直接覆盖实例属性，后续对 originWhiteList 的访问由外部 types 管理
            // 因为 TypeScript 局限，本处以 any 方式扩展属性
            ; (this as any).originWhiteList = [this.origin, ...originWhiteList];
        }

        // 绑定 message 事件
        window.addEventListener('message', this.#handleMessageEvent);

        // 初始化注册
        this.#initRegistration().catch((err: Error) => {
            // 初始化阶段抛错仅打印
            // eslint-disable-next-line no-console
            console.error('IframeBridge init error', err);
        });
    }

    #handleMessageEvent(e: MessageEvent): void {
        // 忽略异常格式事件
        if (!e || !e.data || typeof e.data.type !== 'string') return;
        if (this.isMainPage()) {
            // 主页面处理消息
            this.#receiveMessage(e);
        } else {
            // iframe 页面处理消息
            this.#handleMessageFromEvent(e);
        }
    }

    destory() {
        window.removeEventListener("message", this.#handleMessageEvent)
    }

    isMainPage(): boolean {
        return this.role === 'main';
    }

    // 校验 origin
    #checkOrigin(origin: string): boolean {
        if (!origin) return false
        if (!this.isMainPage()) return false
        // 如果配置了白名单，就使用白名单对 origin 进行校验
        const originWhiteList = (this as any).originWhiteList
        return Array.isArray(originWhiteList) && originWhiteList.length > 0 && !originWhiteList.includes(origin)
    }

    #getMessageKey(): string {
        this._msgCounter = (this._msgCounter + 1) & 0xfffffff;
        return `msg_${Date.now()}_${this._msgCounter}_${Math.random().toString(36).slice(2, 8)}`;
    }

    #defaultEncode(obj: unknown): string | null {
        try {
            const str = JSON.stringify(obj === undefined ? null : obj);
            // utf8 -> percent-encoding -> binary string -> base64
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p) =>
                String.fromCharCode(Number('0x' + p))
            ));
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('IframeBridge: default encode failed', e);
            return null;
        }
    }

    #defaultDecode(str: unknown): unknown {
        try {
            if (str === null || str === undefined) return null;
            if (typeof str === 'object') return str;
            // 将 base64 转回 utf8 JSON 串
            const s = String(str);
            const decoded = decodeURIComponent(Array.prototype.map.call(atob(s), (c: string) =>
                '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
            ).join(''));
            return JSON.parse(decoded);
        } catch (e) {
            // 不是 base64 JSON，就返回原始字符串
            return str;
        }
    }

    async #encodePayload(payload: unknown): Promise<string | object | null> {
        // 如果 payload 已是 string 且没有自定义 encode，则绕过默认编码
        if (typeof payload === 'string' && !this.encodeFn) return payload;

        if (this.encodeFn) {
            try {
                const res = this.encodeFn(payload);
                const awaited = res instanceof Promise ? await res : res;
                if (typeof awaited === 'string' || typeof awaited === 'object') return awaited;
                // 非法返回，回退到默认
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('IframeBridge: custom encodeFn error', e);
            }
        }

        // 回退到默认编码（会把对象编码为 base64 字符串）
        return this.#defaultEncode(payload);
    }

    async #decodePayload(payload: unknown, meta?: { origin?: string; sourceWindow?: Window | null }): Promise<unknown> {
        if (this.decodeFn) {
            try {
                const res = this.decodeFn(payload, meta);
                const awaited = res instanceof Promise ? await res : res;
                if (awaited !== undefined) return awaited;
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('IframeBridge: custom decodeFn error', e);
            }
        }
        return this.#defaultDecode(payload);
    }

    // -------------------------
    // message path 管理（记录经过节点）
    // -------------------------
    #addMessagePath(path: string[] = []): string[] {
        const newPath = [...path];
        if (!newPath.includes(this.iframeId)) newPath.push(this.iframeId);
        return newPath;
    }

    // -------------------------
    // 创建消息（会对 data 进行 encode）
    // -------------------------
    async #createMessage(message: Partial<IframeMessage> = {}, type = 'message'): Promise<IframeMessage> {
        const dataEncoded = await this.#encodePayload(message.data ?? {});
        return {
            type: (type || message.type || 'message') as 'register' | 'message',
            key: message.key || this.#getMessageKey(),
            sourceId: message.sourceId || this.iframeId,
            targetId: message.targetId || this.defaultMainPageId,
            origin: this.origin || window.location.origin,
            path: this.#addMessagePath(message?.path),
            data: dataEncoded,
            timestamp: Date.now()
        } as IframeMessage;
    }

    // -------------------------
    // 初始化注册（主页面自注册；子页面向 parent 注册）
    // -------------------------
    async #initRegistration(): Promise<void> {
        if (this.isMainPage()) {
            // 主页面记录自身注册信息
            this.registeredIframe[this.defaultMainPageId] = { id: this.defaultMainPageId, iframe: null, origin: this.origin };
            // 构造注册消息并同步触发本地回调（与子页面收到 registerSuccess 保持一致）
            const registerMsg = await this.#createMessage({ sourceId: this.defaultMainPageId }, 'register');
            await this.#ensureCallbackReady();
            if (typeof this.messageCallback === 'function') {
                const decoded = await this.#decodePayload(registerMsg.data, { origin: this.origin });
                this.messageCallback({ ...registerMsg, data: decoded });
            }
        } else {
            // 子页面向父页面注册（createMessage 会 encode data）
            const registerMsg = await this.#createMessage({ targetId: this.defaultMainPageId }, 'register');
            this.sendMessage(registerMsg);
        }
    }

    // 等待 onMessage 注册
    async #ensureCallbackReady(): Promise<void> {
        try {
            await this.messageCallbackReady;
        } catch (_) { }
    }

    // -------------------------
    // 主页面接收 message 事件（包装 event -> 入队）
    // -------------------------
    #receiveMessage(event: MessageEvent): void {
        const incoming = event.data;
        const origin = event.origin;
        const source = event.source;

        if (!incoming || typeof incoming.type !== 'string') return;

        switch (incoming.type) {
            case 'register': {
                // 注册请求入队，保留 origin/source 用于回传
                this.registerQuene.push({ ...incoming, _origin: origin, _sourceWindow: source });
                this.#registerIframe();
                break;
            }
            case 'message': {
                // 白名单校验（主页面）
                if (this.#checkOrigin(origin)) {
                    // eslint-disable-next-line no-console
                    console.warn(`IframeBridge: Ignored message from origin ${origin} not in whitelist`);
                    return;
                }
                // 保留 meta 信息供后续 decode 或转发使用
                this.messageQueue.push({ ...incoming, _origin: origin, _sourceWindow: source });
                this.#handleMessage();
                break;
            }
            default:
                return;
        }
    }

    // -------------------------
    // 注册队列处理（主页面）
    // -------------------------
    async #registerIframe(message?: any): Promise<void> {
        if (!this.isMainPage()) {
            // eslint-disable-next-line no-console
            console.error('IframeBridge: Only main page can handle iframe registration');
            return;
        }
        if (this.isHandleRegister) return;
        this.isHandleRegister = true;

        // 优先处理传入 message
        if (message) {
            try {
                await this.#handleRegister(message);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('IframeBridge: Iframe registration failed:', e);
            } finally {
                this.isHandleRegister = false;
            }
            return;
        }

        while (this.registerQuene.length > 0) {
            const msg = this.registerQuene.shift();
            try {
                await this.#handleRegister(msg);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('IframeBridge: Iframe registration failed:', e);
            }
        }

        this.isHandleRegister = false;
    }

    // 处理单条注册
    async #handleRegister(message: any): Promise<void> {
        if (!message) throw new Error('No register message');
        const sourceId: string = message.sourceId;
        const origin: string = message._origin;
        const sourceWindow: Window | null = message._sourceWindow || null;

        // 白名单校验
        if (this.#checkOrigin(origin)) {
            throw new Error(`Origin ${origin} is not in the whitelist`);
        }

        if (!sourceId) throw new Error('Missing sourceId for registration');
        if (this.registeredIframe[sourceId]) throw new Error('Already registered');

        // 绑定 iframe 元素（若存在）
        const boundIframe = sourceWindow ? this.#bindingIframe(sourceWindow) : null;
        this.registeredIframe[sourceId] = { id: sourceId, iframe: boundIframe, origin };

        // eslint-disable-next-line no-console
        console.log(`IframeBridge: page ${sourceId} registered.`);

        // 向注册方回送注册成功消息（createMessage 会 encode data）
        const registerSuccessMsg = await this.#createMessage({ data: 'success', targetId: sourceId }, 'register');
        const rec = this.registeredIframe[sourceId];

        if (rec && rec.iframe && rec.iframe.contentWindow) {
            // 使用注册时记录的 origin 进行 postMessage（更安全）
            rec.iframe.contentWindow.postMessage(registerSuccessMsg, rec.origin || '*');
        } else if (sourceWindow && typeof sourceWindow.postMessage === 'function') {
            sourceWindow.postMessage(registerSuccessMsg, origin || '*');
        } else {
            // eslint-disable-next-line no-console
            console.warn('IframeBridge: No channel to send register success to', sourceId);
        }
    }

    // 绑定 iframe 元素（通过比较 contentWindow）
    #bindingIframe(sourceWindow: Window | null): HTMLIFrameElement | null {
        if (!sourceWindow) return null;
        const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
        return Array.from(iframes).find((iframe) => iframe.contentWindow === sourceWindow) || null;
    }

    // -------------------------
    // 主页面消息消费与转发
    // -------------------------
    async #handleMessage(): Promise<void> {
        if (!this.isMainPage()) return;
        if (this.isHandleMessage) return;
        this.isHandleMessage = true;

        while (this.messageQueue.length > 0) {
            const raw = this.messageQueue.shift() as (IframeMessage & { _origin?: string; _sourceWindow?: Window | null });
            try {
                // decode payload（支持异步 decode）
                const decoded = await this.#decodePayload(raw.data, { origin: raw._origin, sourceWindow: raw._sourceWindow });
                raw.data = decoded;

                if (raw.targetId === this.iframeId) {
                    // 目标为主页面，触发回调
                    await this.#ensureCallbackReady();
                    if (typeof this.messageCallback === 'function') this.messageCallback(raw);
                } else {
                    // 转发到目标 iframe（如果注册）
                    const target = this.registeredIframe[raw.targetId];
                    if (target && target.iframe && target.iframe.contentWindow) {
                        raw.path = this.#addMessagePath(raw.path || []);
                        target.iframe.contentWindow.postMessage(raw, target.origin || '*');
                    } else {
                        // eslint-disable-next-line no-console
                        console.warn(`IframeBridge: Target iframe ${raw.targetId} not found for forwarding`);
                    }
                }
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('IframeBridge: Error handling message', e);
            }
        }

        this.isHandleMessage = false;
    }

    // -------------------------
    // 子页面接收事件处理（包含 decode 并触发回调）
    // -------------------------
    async #handleMessageFromEvent(event: MessageEvent): Promise<void> {
        const raw = event.data as IframeMessage;
        const origin = event.origin;
        const sourceWindow = event.source as Window | null;

        try {
            // decode payload（支持异步 decode）
            const decoded = await this.#decodePayload(raw.data, { origin, sourceWindow });
            raw.data = decoded;
            raw._origin = origin;

            // 更新路径并触发回调
            raw.path = this.#addMessagePath(raw.path || []);
            await this.#ensureCallbackReady();
            if (typeof this.messageCallback === 'function') this.messageCallback(raw);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('IframeBridge: Error in child message handler', e);
        }
    }

    // -------------------------
    // 发送消息（外部调用）
    // - message 可以是简短对象 { targetId, data, ... } 或完整 message（包含 key）
    // - data 可以是 string 或 object；createMessage 会对 object 编码（若使用默认编码）
    // -------------------------
    async sendMessage(message: Partial<IframeMessage> & { targetId?: string } = {}, type = 'message'): Promise<void> {
        if (!message.targetId) return;
        if (message.targetId === this.iframeId) {
            // eslint-disable-next-line no-console
            console.warn('IframeBridge: Cannot send message to itself');
            return;
        }

        // 主页面向未注册 target 不允许发送
        if (this.isMainPage() && !this.registeredIframe[message.targetId]) {
            // eslint-disable-next-line no-console
            console.warn(`IframeBridge: Target iframe ${message.targetId} is not registered`);
            return;
        }

        // 如果外部传入完整 message（包含 key），则直接使用；否则创建（会 encode data）
        const msg = (message as IframeMessage).key ? (message as IframeMessage) : await this.#createMessage(message, type);

        // 更新路径
        (msg as IframeMessage).path = this.#addMessagePath((msg as IframeMessage).path || []);

        if (this.isMainPage()) {
            if (msg.targetId === this.defaultMainPageId) {
                // 目标为主页面：decode 并回调
                const decoded = await this.#decodePayload(msg.data, { origin: msg.origin });
                (msg as IframeMessage).data = decoded;
                await this.#ensureCallbackReady();
                if (typeof this.messageCallback === 'function') this.messageCallback(msg as IframeMessage);
            } else {
                // 转发到目标 iframe
                const target = this.registeredIframe[msg.targetId];
                if (target && target.iframe && target.iframe.contentWindow) {
                    target.iframe.contentWindow.postMessage(msg, target.origin || '*');
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(`IframeBridge: Target iframe ${msg.targetId} not available for postMessage`);
                }
            }
        } else {
            // 子页面：发给 parent，由主页面中转
            try {
                window.parent.postMessage(msg, this.origin || '*');
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('IframeBridge: postMessage to parent failed', e);
            }
        }
    }

    // -------------------------
    // 注册消息回调（外部调用）
    // - callback(msg) 在消息目标为本实例时被调用（msg.data 已解码）
    // -------------------------
    onMessage(callback: (msg: IframeMessage) => void): void {
        if (typeof callback !== 'function') throw new Error('onMessage callback must be a function');
        this.messageCallback = callback;
        this._resolveMessageCallbackReady();
    }

}
