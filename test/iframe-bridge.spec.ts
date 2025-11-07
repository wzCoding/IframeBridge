import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IframeBridge } from '../src/iframe-bridge';

describe('IframeBridge 基本与进阶行为', () => {
  beforeEach(() => {
    // 清理文档中的 iframe，重置全局状态
    document.querySelectorAll('iframe').forEach((n) => n.remove());
  });

  it('默认 encode/decode 能正确传输对象数据（主/子流程）', async () => {
    const main = new IframeBridge({ iframeId: 'main', type: 'main' });
    const child = new IframeBridge({ iframeId: 'child', type: 'iframe' });

    const msgs: any[] = [];
    main.onMessage((m) => msgs.push(m));

    // 子页面向主页面发送消息（通过 sendMessage -> parent.postMessage）
    await child.sendMessage({ targetId: 'main', data: { hello: 'world' } }, 'message');

    // 等待微任务队列使得 message 事件被处理（jsdom 环境）
    await new Promise((r) => setTimeout(r, 0));

    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const received = msgs.find((m) => m.sourceId === 'child' || m.data?.hello === 'world');
    expect(received).toBeDefined();
    expect(received.data).toMatchObject({ hello: 'world' });
    expect(received.path.includes('child')).toBe(true);
  });

  it('自定义同步 encode/decode 生效', async () => {
    const encode = (p: unknown) => `ENC:${JSON.stringify(p)}`;
    const decode = (e: unknown) => {
      if (typeof e === 'string' && e.startsWith('ENC:')) return JSON.parse(e.slice(4));
      return e;
    };

    const main = new IframeBridge({ iframeId: 'main', type: 'main', encodeFn: encode, decodeFn: decode });
    const child = new IframeBridge({ iframeId: 'child', type: 'iframe', encodeFn: encode, decodeFn: decode });

    const msgs: any[] = [];
    main.onMessage((m) => msgs.push(m));

    await child.sendMessage({ targetId: 'main', data: { x: 1 } }, 'message');
    await new Promise((r) => setTimeout(r, 0));

    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].data).toMatchObject({ x: 1 });
  });

  it('自定义异步 encode/decode 生效', async () => {
    const encodeAsync = async (p: unknown) => {
      await new Promise((r) => setTimeout(r, 1));
      return `AENC:${JSON.stringify(p)}`;
    };
    const decodeAsync = async (e: unknown) => {
      await new Promise((r) => setTimeout(r, 1));
      if (typeof e === 'string' && e.startsWith('AENC:')) return JSON.parse(e.slice(5));
      return e;
    };

    const main = new IframeBridge({ iframeId: 'main', type: 'main', encodeFn: encodeAsync, decodeFn: decodeAsync });
    const child = new IframeBridge({ iframeId: 'child', type: 'iframe', encodeFn: encodeAsync, decodeFn: decodeAsync });

    const msgs: any[] = [];
    main.onMessage((m) => msgs.push(m));

    await child.sendMessage({ targetId: 'main', data: { async: true } }, 'message');
    await new Promise((r) => setTimeout(r, 10));

    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].data).toMatchObject({ async: true });
  });

  it('主页面能将消息转发到指定已注册 iframe', async () => {
    // 创建一个 "iframe" 元素并把它插入文档，绑定 contentWindow 以增加匹配概率
    const iframeEl = document.createElement('iframe');
    document.body.appendChild(iframeEl);

    const main = new IframeBridge({ iframeId: 'main', type: 'main' });
    const childA = new IframeBridge({ iframeId: 'childA', type: 'iframe' });
    const childB = new IframeBridge({ iframeId: 'childB', type: 'iframe' });

    // 模拟 childA 向 main 注册并确保 registered
    main.onMessage(() => {}); // 确保主页面回调已就绪
    await childA.sendMessage({ targetId: 'main', data: 'reg-A' }, 'register');
    await childB.sendMessage({ targetId: 'main', data: 'reg-B' }, 'register');
    await new Promise((r) => setTimeout(r, 10));

    // main 给 childB 发送消息（通过 sendMessage）
    // 为了捕获 childB 的回调，在 childB 上监听
    const childBMsgs: any[] = [];
    childB.onMessage((m) => childBMsgs.push(m));

    await main.sendMessage({ targetId: 'childB', data: { ping: 'pong' } }, 'message');
    await new Promise((r) => setTimeout(r, 10));

    expect(childBMsgs.length).toBeGreaterThanOrEqual(1);
    expect(childBMsgs[0].data).toMatchObject({ ping: 'pong' });
  });

  it('不能把消息发送给自己（会有警告但不会抛）', async () => {
    const main = new IframeBridge({ iframeId: 'main', type: 'main' });
    // spy console.warn
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await main.sendMessage({ targetId: 'main', data: 'nope' }, 'message');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('origin 白名单拦截不在白名单的消息', async () => {
    // 为了测试白名单，把实例化时传入 originWhitelist（仅包含 fake origin）
    const main = new IframeBridge({ iframeId: 'main', type: 'main', origin: 'https://good.origin', originWhiteList: ['https://good.origin'] });
    const child = new IframeBridge({ iframeId: 'child', type: 'iframe', origin: 'https://bad.origin' });

    const msgs: any[] = [];
    main.onMessage((m) => msgs.push(m));

    // 直接构造一个 message event 模拟来自 bad.origin
    const badMsg = {
      type: 'message',
      key: 'k',
      sourceId: 'child',
      targetId: 'main',
      origin: 'https://bad.origin',
      path: [],
      data: 'hello',
      timestamp: Date.now()
    };

    // 派发一个 message 事件到 window（模拟 postMessage）
    window.dispatchEvent(new MessageEvent('message', { data: badMsg, origin: 'https://bad.origin', source: window }));

    await new Promise((r) => setTimeout(r, 0));

    expect(msgs.length).toBe(0);
  });
});
