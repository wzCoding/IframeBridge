// src/__tests__/iframeBridge.spec.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IframeBridge } from '../src/iframe-bridge';
import type { IframeMessage } from '../src/type';

function makeIframe(id = 'child', origin = 'http://example.com') {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-mock-id', id);
  document.body.appendChild(iframe);
  return iframe;
}

describe('IframeBridge - 单元与集成测试（每个页面主动注册）', () => {
  beforeEach(() => {
    // 清理 DOM 与全局状态
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // it('编码/解码字符串应保持 Unicode 并返回原字符串', () => {
  //   const bridge = new IframeBridge();
  //   const s = 'hello 你好 🌏';
  //   const encoded = bridge.enCodeMessage(s);
  //   expect(typeof encoded).toBe('string');
  //   const decoded = bridge.deCodeMessage(encoded);
  //   expect(decoded).toBe(s);
  //   bridge.destroy();
  // });

  // it('编码/解码对象应保持结构一致', () => {
  //   const bridge = new IframeBridge();
  //   const obj = { a: 1, b: 'bb', c: { nested: true } };
  //   const encoded = bridge.enCodeMessage(obj);
  //   expect(typeof encoded).toBe('string');
  //   const decoded = bridge.deCodeMessage(encoded);
  //   expect(decoded).toEqual(obj);
  //   bridge.destroy();
  // });

  // it('createMessage 应包含必要字段且 path 包含 iframeId', () => {
  //   const bridge = new IframeBridge({ iframeId: 'main' });
  //   const msg = (bridge as any).createMessage?.({ data: 'x' }, 'message') as IframeMessage;
  //   expect(msg).toHaveProperty('key');
  //   expect(msg.sourceId).toBe('main');
  //   expect(msg.origin).toBe(window.location.origin);
  //   expect(Array.isArray(msg.path)).toBe(true);
  //   expect((msg.path as string[]).includes('main')).toBe(true);
  //   bridge.destroy();
  // });

  // it('子页面主动向父页面发送注册请求，父页面应记录注册信息（无白名单）', async () => {
  //   // 主页面实例（显式类型 main）
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main' });
  //   // 创建 iframe（DOM token），模拟子页面
  //   const iframe = makeIframe('child1');
  //   const childWindow = (iframe.contentWindow as Window) || ({} as Window);

  //   // 模拟子页面：它会创建自己的 IframeBridge 并向 parent 发送 register
  //   const child = new IframeBridge({ type: 'iframe', iframeId: 'child1', origin: window.location.origin });

  //   // 因为在 jsdom 中 postMessage 的 targetOrigin 与 origin 行为可能受限，
  //   // 我们直接触发主页面的 message 事件以模拟子页面发送 register
  //   const regMsg = { type: 'register', sourceId: 'child1', origin: window.location.origin };
  //   window.dispatchEvent(new MessageEvent('message', { data: regMsg, source: childWindow, origin: regMsg.origin }));

  //   // 等待异步注册处理
  //   await new Promise((r) => setTimeout(r, 30));

  //   // 主页面应已记录 child1（iframe 可能为 null，但条目应存在）
  //   expect((main as any).registeredIframe['child1']).toBeDefined();

  //   child.destroy();
  //   main.destroy();
  // });

  // it('当提供白名单且来源不在白名单中时子页面注册应被父页面拒绝', async () => {
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main', originWhitelist: ['http://good.example'] });
  //   const iframe = makeIframe('badchild');
  //   const sourceWindow = (iframe.contentWindow as Window) || ({} as Window);

  //   // 子页面主动发起注册（来源为 bad origin）
  //   const regMsg = { type: 'register', sourceId: 'badchild', origin: 'http://bad.example' };
  //   // 模拟子页面 postMessage 到父页面
  //   window.dispatchEvent(new MessageEvent('message', { data: regMsg, source: sourceWindow, origin: regMsg.origin }));

  //   await new Promise((r) => setTimeout(r, 30));
  //   // 父页面不应记录该注册
  //   expect((main as any).registeredIframe['badchild']).toBeUndefined();
  //   main.destroy();
  // });

  it('子页面发送消息到父页面，父页面应接收并得到已解码的数据', async () => {
    const parent = new IframeBridge({ type: 'main', iframeId: 'main', origin: "*" });
    makeIframe('child2'); // 确保 DOM 中存在 iframe 元素

    // 集中接收：只注册一次 onMessage，把所有消息推入数组
    const received: IframeMessage[] = [];
    parent.onMessage((m) => received.push(m));

    // helper: 等待父端 registeredIframe 中出现 childId（访问私有字段）
    function waitForRegistered(parentInstance: any, childId: string, timeout = 2000): Promise<void> {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
          if (parentInstance.registeredIframe && parentInstance.registeredIframe[childId]) {
            clearInterval(iv);
            resolve();
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(iv);
            reject(new Error('waitForRegistered timeout'));
          }
        }, 10);
      });
    }

    const child = new IframeBridge({
      type: 'iframe',
      iframeId: 'child2',
      origin: "*",
    });

    // 等父端实际记录子 iframe（避免竞态）
    await waitForRegistered(parent as any, 'child2', 2000);

    // 发送业务消息（使用公开 API）
    const payload = { ok: true, text: '测试' };
    child.sendMessage({ targetId: 'main', data: payload }, 'message');

    // 等待父端收到并断言解码结果
    const start = Date.now();
    const msg = await new Promise<IframeMessage>((resolve, reject) => {
      const iv = setInterval(() => {
        for (const m of received) {
          if (m.type === 'message' && m.sourceId === 'child2' && m.data && (m.data as any).ok === true) {
            clearInterval(iv);
            resolve(m);
            return;
          }
        }
        if (Date.now() - start > 2000) {
          clearInterval(iv);
          reject(new Error('message timeout'));
        }
      }, 10);
    });

    expect(msg).toHaveProperty('data');
    expect(msg.data).toMatchObject(payload);

    child.destroy();
    parent.destroy();
  });

  // it('主页面能将消息转发到目标 iframe（模拟 postMessage）', async () => {
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main' });
  //   const iframe = makeIframe('child3');
  //   const cw = iframe.contentWindow as any;
  //   cw.postMessage = vi.fn();

  //   // 将 child3 注册到主页面（模拟注册结果，iframe DOM 引用存在）
  //   (main as any).registeredIframe['child3'] = { id: 'child3', iframe, origin: 'http://example.com' };

  //   // 主页面发送消息到 child3
  //   main.sendMessage({ targetId: 'child3', data: { hi: 1 } }, 'message');

  //   expect(cw.postMessage).toHaveBeenCalled();
  //   const [msgArg, originArg] = cw.postMessage.mock.calls[0];
  //   expect(msgArg).toHaveProperty('type', 'message');
  //   expect(originArg).toBe('http://example.com');
  //   main.destroy();
  // });

  // it('消息队列应串行处理（主页面接收多条消息并依次回调）', async () => {
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main' });
  //   const iframe = makeIframe('child4');
  //   const childWin = (iframe.contentWindow as Window) || ({} as Window);

  //   const cb = vi.fn();
  //   main.onMessage(cb);

  //   // 模拟 child4 注册并发送多条 message 到 main
  //   window.dispatchEvent(new MessageEvent('message', { data: { type: 'register', sourceId: 'child4', origin: window.location.origin }, source: childWin, origin: window.location.origin }));
  //   await new Promise((r) => setTimeout(r, 10));
  //   const enc1 = main.enCodeMessage({ x: 1 });
  //   const enc2 = main.enCodeMessage({ x: 2 });

  //   window.dispatchEvent(new MessageEvent('message', { data: { type: 'message', sourceId: 'child4', targetId: 'main', data: enc1 }, source: childWin, origin: window.location.origin }));
  //   window.dispatchEvent(new MessageEvent('message', { data: { type: 'message', sourceId: 'child4', targetId: 'main', data: enc2 }, source: childWin, origin: window.location.origin }));

  //   await new Promise((r) => setTimeout(r, 40));
  //   expect(cb).toHaveBeenCalledTimes(2);
  //   const first = cb.mock.calls[0][0];
  //   const second = cb.mock.calls[1][0];
  //   expect(first.data).toMatchObject({ x: 1 });
  //   expect(second.data).toMatchObject({ x: 2 });

  //   main.destroy();
  // });

  // it('destroy 应移除事件监听并停止处理后续消息', async () => {
  //   const bridge = new IframeBridge({ type: 'main', iframeId: 'main' });
  //   const spyRemove = vi.spyOn(window, 'removeEventListener');
  //   bridge.destroy();
  //   expect((bridge as any)._destroyed).toBe(true);
  //   expect(spyRemove).toHaveBeenCalled();

  //   const cb = vi.fn();
  //   bridge.onMessage(cb);
  //   const event = new MessageEvent('message', { data: { type: 'message', targetId: 'main', data: bridge.enCodeMessage({ x: 1 }) }, origin: window.location.origin });
  //   window.dispatchEvent(event);
  //   await new Promise((r) => setTimeout(r, 20));
  //   expect(cb).not.toHaveBeenCalled();

  //   spyRemove.mockRestore();
  // });

  // it('onMessage 在注册成功前后都能保证收到注册成功回调', async () => {
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main' });
  //   const iframe = makeIframe('child5');
  //   const childWin = (iframe.contentWindow as Window) || ({} as Window);

  //   // 子页面先发起注册（在主页面设置 onMessage 之前）
  //   window.dispatchEvent(new MessageEvent('message', { data: { type: 'register', sourceId: 'child5', origin: window.location.origin }, source: childWin, origin: window.location.origin }));

  //   // 等一小段时间让主页面处理注册并等待回调时机
  //   await new Promise((r) => setTimeout(r, 10));

  //   // 现在主页面设置 onMessage，注册成功回调应尽快触发
  //   const cb = vi.fn();
  //   main.onMessage(cb);

  //   await new Promise((r) => setTimeout(r, 30));
  //   expect(cb).toHaveBeenCalled();

  //   main.destroy();
  // });

  // it('向自身发送消息应发出警告且不发送', () => {
  //   const bridge = new IframeBridge({ type: 'iframe', iframeId: 'selfie' });
  //   const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
  //   bridge.sendMessage({ targetId: 'selfie', data: { a: 1 } }, 'message');
  //   expect(warnSpy).toHaveBeenCalled();
  //   warnSpy.mockRestore();
  //   bridge.destroy();
  // });

  // it('当 originWhitelist 为 undefined 时应禁用来源校验并接受任意 origin 注册', async () => {
  //   const main = new IframeBridge({ type: 'main', iframeId: 'main', originWhitelist: undefined });
  //   const iframe = makeIframe('anychild');
  //   const src = (iframe.contentWindow as Window) || ({} as Window);
  //   const reg = { type: 'register', sourceId: 'anychild', origin: 'http://random.origin' };
  //   window.dispatchEvent(new MessageEvent('message', { data: reg, source: src, origin: reg.origin }));
  //   await new Promise((r) => setTimeout(r, 30));
  //   expect((main as any).registeredIframe['anychild']).toBeDefined();
  //   main.destroy();
  // });
});