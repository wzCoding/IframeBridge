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

function buildRegisterData(sourceId: string, origin = 'http://example.com') {
  return {
    type: 'register',
    sourceId,
    origin,
  } as unknown as IframeMessage;
}

describe('IframeBridge - 单元与集成测试', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('编码/解码字符串应保持 Unicode 并返回原字符串', () => {
    const bridge = new IframeBridge();
    const s = 'hello 你好 🌏';
    const encoded = bridge.enCodeMessage(s);
    expect(typeof encoded).toBe('string');
    const decoded = bridge.deCodeMessage(encoded);
    expect(decoded).toBe(s);
    bridge.destroy();
  });

  it('编码/解码对象应保持结构一致', () => {
    const bridge = new IframeBridge();
    const obj = { a: 1, b: 'bb', c: { nested: true } };
    const encoded = bridge.enCodeMessage(obj);
    expect(typeof encoded).toBe('string');
    const decoded = bridge.deCodeMessage(encoded);
    expect(decoded).toEqual(obj);
    bridge.destroy();
  });

  it('createMessage 应包含必要字段且 path 包含 iframeId', () => {
    const bridge = new IframeBridge({ iframeId: 'my-iframe' });
    const msg = (bridge as any).createMessage?.({ data: 'x' }, 'message') as IframeMessage;
    expect(msg).toHaveProperty('key');
    expect(msg.sourceId).toBe('my-iframe');
    expect(msg.origin).toBe(window.location.origin);
    expect(Array.isArray(msg.path)).toBe(true);
    expect((msg.path as string[]).includes('my-iframe')).toBe(true);
    bridge.destroy();
  });

  it('主页面在未传入白名单时应接受注册请求', async () => {
    const main = new IframeBridge({ type: 'main' });
    const iframe = makeIframe('child1', 'http://a.test');
    const sourceWindow = (iframe.contentWindow as Window) || ({} as Window);
    const sendSpy = vi.spyOn(main as any, 'sendMessage');
    const regMsg = { type: 'register', sourceId: 'child1', origin: 'http://a.test' };
    const event = new MessageEvent('message', { data: regMsg, source: sourceWindow, origin: regMsg.origin });
    window.dispatchEvent(event);

    await new Promise((r) => setTimeout(r, 50));

    expect((main as any).registeredIframe['child1']).toBeDefined();
    expect(sendSpy).toHaveBeenCalled();
    main.destroy();
  });

  it('当提供白名单且来源不在白名单中时注册应被拒绝', async () => {
    const main = new IframeBridge({ type: 'main', originWhitelist: ['http://good.example'] });
    const iframe = makeIframe('badchild', 'http://bad.example');
    const sourceWindow = (iframe.contentWindow as Window) || ({} as Window);

    const event = new MessageEvent('message', {
      data: { type: 'register', sourceId: 'badchild', origin: 'http://bad.example' },
      source: sourceWindow,
      origin: 'http://bad.example',
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.dispatchEvent(event);

    await new Promise((r) => setTimeout(r, 50));
    expect((main as any).registeredIframe['badchild']).toBeUndefined();
    errSpy.mockRestore();
    main.destroy();
  });

  it('子页面向父页面发送消息时父页面应接收并得到已解码的数据', async () => {
    const parent = new IframeBridge({ type: 'main', iframeId: 'main' });
    const iframe = makeIframe('child2');
    const cw = iframe.contentWindow as Window;
    (parent as any).registeredIframe['child2'] = { id: 'child2', iframe, origin: 'http://example.com' };

    const child = new IframeBridge({ type: 'iframe', iframeId: 'child2', origin: window.location.origin });
    const onMsgSpy = vi.fn();
    parent.onMessage(onMsgSpy);

    child.sendMessage({ targetId: 'main', data: { ok: true } }, 'message');

    await new Promise((r) => setTimeout(r, 20));

    expect(onMsgSpy).toHaveBeenCalled();
    const received = onMsgSpy.mock.calls[0][0];
    expect(received).toHaveProperty('data');
    expect(received.data).toMatchObject({ ok: true });
    parent.destroy();
    child.destroy();
  });

  it('主页面应将消息转发到目标 iframe', async () => {
    const main = new IframeBridge({ type: 'main', iframeId: 'main' });
    const iframe = makeIframe('child3');
    const cw = iframe.contentWindow as any;
    cw.postMessage = vi.fn();
    (main as any).registeredIframe['child3'] = { id: 'child3', iframe, origin: 'http://example.com' };

    main.sendMessage({ targetId: 'child3', data: { hi: 1 } }, 'message');

    expect(cw.postMessage).toHaveBeenCalled();
    const [msgArg, originArg] = cw.postMessage.mock.calls[0];
    expect(msgArg).toHaveProperty('type', 'message');
    expect(originArg).toBe('http://example.com');
    main.destroy();
  });

  it('消息队列应串行处理，isHandlingMessage 应防止 reentry', async () => {
    const main = new IframeBridge({ type: 'main', iframeId: 'main' });
    const iframe = makeIframe('child4');
    (main as any).registeredIframe['child4'] = { id: 'child4', iframe, origin: 'http://example.com' };

    const m1 = { type: 'message', sourceId: 'child4', targetId: 'main', data: main.enCodeMessage({ x: 1 }) };
    const m2 = { type: 'message', sourceId: 'child4', targetId: 'main', data: main.enCodeMessage({ x: 2 }) };
    (main as any).messageQueue.push(m1, m2);

    const cb = vi.fn();
    main.onMessage(cb);

    // 调用内部 handler（若为私有方法在你的实现中可能需改用公有 API）
    await (main as any).handleMessage?.();
    await new Promise((r) => setTimeout(r, 20));

    expect(cb).toHaveBeenCalledTimes(2);
    main.destroy();
  });

  it('destroy 应移除事件监听并停止处理消息', async () => {
    const bridge = new IframeBridge({ type: 'main', iframeId: 'main' });
    const spyRemove = vi.spyOn(window, 'removeEventListener');
    bridge.destroy();
    expect((bridge as any)._destroyed).toBe(true);
    expect(spyRemove).toHaveBeenCalled();
    const cb = vi.fn();
    bridge.onMessage(cb);
    const event = new MessageEvent('message', { data: { type: 'message', targetId: 'main', data: bridge.enCodeMessage({ x: 1 }) }, origin: window.location.origin });
    window.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).not.toHaveBeenCalled();
    spyRemove.mockRestore();
  });

  it('onMessage 应使 messageCallbackReady resolve，注册成功后可回调', async () => {
    const main = new IframeBridge({ type: 'main', iframeId: 'main' });
    const iframe = makeIframe('child5');
    const source = iframe.contentWindow as Window;
    const regMsg = { type: 'register', sourceId: 'child5', origin: window.location.origin };
    window.dispatchEvent(new MessageEvent('message', { data: regMsg, source, origin: regMsg.origin }));
    await new Promise((r) => setTimeout(r, 20));
    const cb = vi.fn();
    main.onMessage(cb);
    await new Promise((r) => setTimeout(r, 30));
    expect(cb).toHaveBeenCalled();
    main.destroy();
  });

  it('向自身发送消息应发出警告且不发送', () => {
    const bridge = new IframeBridge({ type: 'iframe', iframeId: 'selfie' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.sendMessage({ targetId: 'selfie', data: { a: 1 } }, 'message');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    bridge.destroy();
  });

  it('当 originWhitelist 为 undefined 时应禁用来源校验并接受任意 origin 注册', async () => {
    const main = new IframeBridge({ type: 'main', iframeId: 'main', originWhitelist: undefined });
    const iframe = makeIframe('anychild');
    const src = iframe.contentWindow as Window;
    const reg = { type: 'register', sourceId: 'anychild', origin: 'http://random.origin' };
    window.dispatchEvent(new MessageEvent('message', { data: reg, source: src, origin: reg.origin }));
    await new Promise((r) => setTimeout(r, 30));
    expect((main as any).registeredIframe['anychild']).toBeDefined();
    main.destroy();
  });
});
