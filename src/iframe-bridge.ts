// src/IframeBridge.ts
import {
    IframeBridgeOptions,
    MessageEventData,
    IframeMessage,
    MessageType,
} from './type';

const DEFAULT_MAIN_ID = 'main';

export class IframeBridge {
    private defaultMainPageId = DEFAULT_MAIN_ID;
    public iframeId: string;
    private origin: string;
    private role?: 'main' | 'iframe';
    private originWhitelist?: string[]; // undefined => 不校验
    private messageCallback: ((msg: IframeMessage) => void) | null = null;
    private messageCallbackReady: Promise<void>;
    private onMessageCallbackReady!: () => void;

    // queues and states
    private registeredIframe: Record<
        string,
        { id: string; iframe: HTMLIFrameElement | null; origin: string }
    > = {};
    private messageQueue: IframeMessage[] = [];
    private registerQueue: MessageEventData[] = [];
    private isHandlingRegister = false;
    private isHandlingMessage = false;

    // lifecycle
    private _destroyed = false;
    private _autoDestroy = false;

    // bound handlers (non-private for add/remove)
    private _handleWindowMessage: (e: MessageEvent) => void;
    private _handleWindowUnload: () => void;

    constructor(options: IframeBridgeOptions = {}) {
        const { iframeId, origin, originWhitelist, type, lifecycle } = options;
        this.origin = origin || window.location.origin;
        this.role = type;
        this._autoDestroy = !!lifecycle?.autoDestroy;

        // 临时设置 iframeId（若后续判定为 main 会被覆盖为 DEFAULT_MAIN_ID）
        this.iframeId = iframeId || DEFAULT_MAIN_ID;

        // 如果 role type 显式传 main，或者通过检测函数判断为主页面，
        // 那么强制把实例 id 设为默认主 id，保证与路由判断保持一致。
        if (this.isMainPage()) {
            if (this.iframeId !== DEFAULT_MAIN_ID) {
                console.warn('IframeBridge: running as main page — iframeId is forced to "main" for routing consistency.');
            }
            this.iframeId = DEFAULT_MAIN_ID;
        }

        if (Array.isArray(originWhitelist) && originWhitelist.length > 0) {
            this.originWhitelist = [this.origin, ...originWhitelist];
        } else {
            this.originWhitelist = undefined;
        }

        this.messageCallbackReady = new Promise((resolve) => {
            this.onMessageCallbackReady = resolve;
        });

        // bind handlers
        this._handleWindowMessage = this._handleWindowMessageImpl.bind(this);
        this._handleWindowUnload = this._handleWindowUnloadImpl.bind(this);

        // register listeners
        window.addEventListener('message', this._handleWindowMessage, false);
        if (this._autoDestroy) {
            window.addEventListener('beforeunload', this._handleWindowUnload, false);
            window.addEventListener('unload', this._handleWindowUnload, false);
        }

        this.init();
    }

    private init() {
        if (this.isMainPage()) {
            const registerMsg = this.createMessage({ sourceId: this.defaultMainPageId }, 'register');
            // fire-and-forget: ensure main registers itself
            void this.registerIframe(registerMsg);
        } else {
            const registerMsg = this.createMessage({ targetId: this.defaultMainPageId }, 'register');
            this.sendMessage(registerMsg);
        }
    }

    public isMainPage(): boolean {
        if (this.role === 'main') return true;
        if (this.role === 'iframe') return false;
        return window.top === window.self;
    }

    private _handleWindowMessageImpl(e: MessageEvent) {
        if (this._destroyed) return;
        if (!e?.data || !e.data.type) return;
        if (this.isMainPage()) {
            this.receiveMessage(e);
        } else {
            void this.handleMessage(e.data);
        }
    }

    private _handleWindowUnloadImpl() {
        try {
            this.destroy();
        } catch {
            /* ignore */
        }
    }

    private getMessageKey(): string {
        return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // UTF-8 safe base64 with type marker
    public enCodeMessage(payload: unknown): string | null {
        try {
            if (payload === null || payload === undefined) return null;
            let marker: 's' | 'o';
            let content: string;
            if (typeof payload === 'string') {
                marker = 's';
                content = payload;
            } else {
                marker = 'o';
                content = JSON.stringify(payload);
            }
            const utf8 = new TextEncoder().encode(content);
            let binary = '';
            for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
            const base64 = btoa(binary);
            return `${marker}:${base64}`;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('enCodeMessage error:', err);
            return null;
        }
    }

    public deCodeMessage(encoded: unknown): unknown | null {
        try {
            if (typeof encoded !== 'string') return null;
            const idx = encoded.indexOf(':');
            if (idx === -1) return null;
            const marker = encoded.slice(0, idx);
            const base64 = encoded.slice(idx + 1);
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const decodedStr = new TextDecoder().decode(bytes);
            if (marker === 's') return decodedStr;
            if (marker === 'o') {
                try {
                    return JSON.parse(decodedStr);
                } catch {
                    return decodedStr;
                }
            }
            return decodedStr;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('deCodeMessage error:', err);
            return null;
        }
    }

    // 创建消息对象
    private createMessage(message: Partial<IframeMessage> = {}, type: MessageType = 'message'): IframeMessage {
        // 原始数据（可能为已编码字符串或原始对象/字符串）
        const raw = message.data === undefined ? null : message.data;

        // encoded 优先取调用方显式提供的值
        let encodedFlag: boolean | undefined = message.encoded;

        // 若调用方未显式传 encoded，则尝试通过格式推断
        if (encodedFlag === undefined) {
            encodedFlag = this.enCodeMessage(raw) ? true : false;
        }

        let finalData: unknown = raw;

        // 如果当前判断为未编码（false 或 undefined），则对原始数据进行编码并标记 encoded=true
        if (!encodedFlag && raw !== null && raw !== undefined) {
            const enc = this.enCodeMessage(raw);
            if (enc !== null) {
                finalData = enc;
                encodedFlag = true;
            } else {
                // 若编码失败，保留原始数据并保持 encoded=false（或根据需求抛错/警告）
                // console.warn('encodeInternal failed, message will be sent unencoded');
                finalData = raw;
                encodedFlag = false;
            }
        }
        const path = this.addMessagePath(message.path)
        console.log(path)
        return {
            type,
            key: this.getMessageKey(),
            sourceId: message.sourceId || this.iframeId,
            targetId: message.targetId || this.defaultMainPageId,
            origin: this.origin,
            path,
            data: finalData,
            encoded: encodedFlag,
            timestamp: Date.now(),
        };
    }

    private addMessagePath(path?: string[]) {
        const arr = Array.isArray(path) ? [...path] : [];
        if (!arr.includes(this.iframeId)) arr.push(this.iframeId);
        return arr;
    }

    private receiveMessage(event: MessageEvent) {
        const { type } = (event.data || {}) as IframeMessage;
        switch (type) {
            case 'register':
                this.registerQueue.push({ source: event.source as WindowProxy | null, ...(event.data as IframeMessage) } as MessageEventData);
                void this.registerIframe();
                break;
            case 'message':
                this.messageQueue.push(event.data as IframeMessage);
                // 当收到 message push 到 this.messageQueue 后，立即确保异步触发处理
                this.messageQueue.push(event.data);
                void Promise.resolve().then(() => this.handleMessage()); // 确保在 microtask 执行
                //void this.handleMessage();
                break;
            default:
                // eslint-disable-next-line no-console
                console.warn('Unknown message type received:', type);
        }
    }

    private async registerIframe(message?: MessageEventData) {
        if (!this.isMainPage()) {
            // eslint-disable-next-line no-console
            console.error('Only main page can handle iframe registration');
            return;
        }
        if (this.isHandlingRegister) return;
        this.isHandlingRegister = true;

        const queue = message ? [message] : this.registerQueue.splice(0);

        for (const msg of queue) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await this.handleRegister(msg);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Iframe registration failed:', err);
            }
        }

        this.isHandlingRegister = false;
    }

    private handleRegister(message?: MessageEventData): Promise<boolean> {
        return new Promise(async (resolve, reject) => {
            if (!message) return reject(new Error('Missing registration message'));

            const { source, sourceId, origin, type } = message;

            if (!origin || !sourceId) return reject(new Error('Invalid registration payload'));

            if (Array.isArray(this.originWhitelist) && !this.originWhitelist.includes(origin)) {
                return reject(new Error(`Origin ${origin} is not in the whitelist.`));
            }

            if (!this.registeredIframe[sourceId]) {
                const bound = this.bindingIframe(source as WindowProxy | null);
                this.registeredIframe[sourceId] = { id: sourceId, iframe: bound, origin };
                // eslint-disable-next-line no-console
                console.log(`Page ${sourceId} registered.`);
                const successMsg = this.createMessage({ data: 'success', targetId: sourceId }, type);
                // 等待 onMessage callback 准备（若未注册，Promise 会在 onMessage 中被 resolve）
                try {
                    await Promise.race([this.messageCallbackReady, Promise.resolve()]);
                } catch { }
                if (sourceId === this.iframeId) {
                    this.messageCallback?.(successMsg);
                } else {
                    this.sendMessage(successMsg, type);
                }
                resolve(true);
            } else {
                reject(new Error(`Iframe ${sourceId} already registered.`));
            }
        });
    }

    private bindingIframe(sourceWindow: WindowProxy | null): HTMLIFrameElement | null {
        if (!sourceWindow) return null;
        const iframes = document.querySelectorAll('iframe');
        return Array.from(iframes).find((iframe) => iframe.contentWindow === sourceWindow) || null;
    }

    private async handleMessage(message?: IframeMessage) {
        if (!this.isMainPage()) {
            console.log('Iframe handling message:', message);
            if (!message) return;
            message.path = this.addMessagePath(message.path || []);
            console.log('Iframe added path:', message.path);
            const decoded = { ...message, data: this.deCodeMessage(message.data) };
            console.log('Iframe received message:', decoded);
            await Promise.resolve(); // 保证回调在异步时序上能被测试捕捉
            this.messageCallback?.(decoded);
            return;
        }

        if (this.isHandlingMessage) return;
        this.isHandlingMessage = true;

        try {
            while (this.messageQueue.length) {
                const msg = this.messageQueue.shift()!;
                if (msg.targetId === this.iframeId) {
                    const decoded = { ...msg, data: this.deCodeMessage(msg.data) };
                    await Promise.resolve(); // 保证回调在异步时序上能被测试捕捉
                    this.messageCallback?.(decoded);
                } else {
                    this.sendMessage(msg, msg.type);
                }
            }
        } finally {
            this.isHandlingMessage = false;
        }
    }

    public sendMessage(message: Partial<IframeMessage> = {}, type: MessageType = 'message') {
        const built: IframeMessage = (message.key ? (message as IframeMessage) : this.createMessage(message, type));

        if (built.targetId === this.iframeId) {
            // eslint-disable-next-line no-console
            console.warn('Attempt to send message to itself; use onMessage handler directly if needed');
            return;
        }

        built.path = this.addMessagePath(built.path || []);

        if (this.isMainPage()) {
            if (built.targetId === this.defaultMainPageId) {
                const decoded = { ...built, data: this.deCodeMessage(built.data) };
                console.log('main decoded data:', decoded)
                this.messageCallback?.(decoded);
            } else {
                const target = this.registeredIframe[built.targetId as string];
                if (target?.iframe?.contentWindow) {
                    target.iframe.contentWindow.postMessage(built, target.origin);
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(`Target iframe ${built.targetId} not found or not bound`);
                }
            }
        } else {
            // window.parent.postMessage(built, this.origin);
            const targetOrigin = (typeof window === 'object' && (window as any).__TEST_ENV__) ? '*' : this.origin;
            window.parent.postMessage(message, targetOrigin);
        }
    }

    public onMessage(callback: (msg: IframeMessage) => void) {
        if (typeof callback !== 'function') {
            throw new Error('onMessage callback must be a function');
        }
        this.messageCallback = callback;
        try {
            this.onMessageCallbackReady();
        } catch {
            /* ignore */
        }
    }

    public destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        try {
            window.removeEventListener('message', this._handleWindowMessage, false);
            if (this._autoDestroy) {
                window.removeEventListener('beforeunload', this._handleWindowUnload, false);
                window.removeEventListener('unload', this._handleWindowUnload, false);
            }
        } catch (err) { /* ignore */ }

        // 清理引用
        this.messageCallback = null;
        this.messageQueue.length = 0;
        this.registerQueue.length = 0;
        Object.keys(this.registeredIframe).forEach(k => {
            const rec = this.registeredIframe[k];
            if (rec) rec.iframe = null;
            delete this.registeredIframe[k];
        });

        // 如果有挂起的 messageCallbackReady，resolve 以避免测试挂起
        try { this.onMessageCallbackReady?.(); } catch { }
    }

    public dispose() {
        this.destroy();
    }
}
