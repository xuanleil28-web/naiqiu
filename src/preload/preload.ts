/**
 * preload
 * ---------------------------------------------------------------------------
 * 唯一的桥：把主进程能力以最小面积暴露给渲染进程。
 * 渲染进程永远拿不到 ipcRenderer 本体，只能用这里白名单过的方法。
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;
type Handler = (...args: unknown[]) => void;

/** 主进程 → 渲染进程 的订阅helper */
function on(channel: string, handler: Handler): Unsubscribe {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** 桌面图标（与主进程 icons.ts 的 DesktopIcon 对应，坐标是窗口内 DIP） */
interface DesktopIcon {
  name: string;
  x: number;
  y: number;
  size: number;
  launchable: boolean;
}

interface LaunchResult {
  ok: boolean;
  error?: string;
  target?: string;
}

const api = {
  /**
   * 切换鼠标穿透。
   * @param value true  = 窗口接收鼠标事件（悬停在小球上 / 拖拽中）
   *              false = 穿透到桌面（默认）
   */
  setInteractive(value: boolean): void {
    ipcRenderer.send('set-interactive', Boolean(value));
  },

  /** 托盘「暂停 / 继续」 */
  onPaused(handler: (paused: boolean) => void): Unsubscribe {
    return on('set-paused', (value) => handler(Boolean(value)));
  },

  /** 托盘「重置小球」 */
  onReset(handler: () => void): Unsubscribe {
    return on('reset-ball', () => handler());
  },

  /** 主屏分辨率变化后需要重新测量画布 */
  onLayoutChanged(handler: () => void): Unsubscribe {
    return on('layout-changed', () => handler());
  },

  /**
   * 读桌面图标（名字 + 窗口内 DIP 矩形 + 能不能启动）。
   * 读不到就返回空数组 —— 渲染进程不需要区分「没有图标」和「读失败」。
   */
  readDesktopIcons(): Promise<DesktopIcon[]> {
    return ipcRenderer.invoke('read-desktop-icons') as Promise<DesktopIcon[]>;
  },

  /**
   * 启动某个图标对应的应用。
   * ★ 只传名字，不传路径：真正打开哪个文件由主进程自己在桌面上找。
   */
  launchDesktopIcon(name: string): Promise<LaunchResult> {
    return ipcRenderer.invoke('launch-desktop-icon', String(name)) as Promise<LaunchResult>;
  },
};

contextBridge.exposeInMainWorld('ballAPI', api);

export type BallAPI = typeof api;
