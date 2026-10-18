export type HotkeyActionId =
  | "toggleOverlay"
  | "emergencyHide"
  | "captureRegion"
  | "captureFull"
  | "toggleListening"
  | "solveGroup"
  | "toggleKnowledge"
  | "resetView"
  | "quit"
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"
  | "opacityDown"
  | "opacityUp"
  | "zoomOut"
  | "zoomReset"
  | "zoomIn"
  | "deleteLastShot"
  | "answerQuestion"
  | "voiceSolve"
  | "pagePrev"
  | "pageNext"
  | "scrollUp"
  | "scrollDown"
  | "toggleClickThrough";

export type HotkeySettings = Record<HotkeyActionId, string>;

export type HotkeyGroup = "通用" | "截图与处理" | "导航" | "窗口与显示";

export type HotkeyDefinition = {
  id: HotkeyActionId;
  label: string;
  description: string;
  group: HotkeyGroup;
  accelerator: string;
  hidden?: boolean;
};

export const HOTKEY_GROUPS: HotkeyGroup[] = ["通用", "截图与处理", "导航", "窗口与显示"];

export const HOTKEY_DEFINITIONS: HotkeyDefinition[] = [
  {
    id: "toggleOverlay",
    label: "显示 / 隐藏",
    description: "在当前屏幕显示或隐藏辅助浮层",
    group: "通用",
    accelerator: "CommandOrControl+B",
  },
  {
    id: "emergencyHide",
    label: "紧急隐身",
    description: "立即停止收音并隐藏浮层",
    group: "通用",
    accelerator: "CommandOrControl+Shift+H",
  },
  {
    id: "quit",
    label: "退出应用",
    description: "关闭辅助浮层并退出进程",
    group: "通用",
    accelerator: "CommandOrControl+Q",
  },
  {
    id: "toggleKnowledge",
    label: "知识库面板",
    description: "打开或关闭知识库面板",
    group: "通用",
    accelerator: "CommandOrControl+K",
  },
  {
    id: "captureRegion",
    label: "区域截图",
    description: "框选屏幕区域并加入当前截图组",
    group: "截图与处理",
    accelerator: "CommandOrControl+H",
  },
  {
    id: "captureFull",
    label: "全屏截图",
    description: "截取整块屏幕并加入当前组",
    group: "截图与处理",
    accelerator: "CommandOrControl+Shift+A",
  },
  {
    id: "solveGroup",
    label: "处理截图",
    description: "对当前截图组发起识题与解答",
    group: "截图与处理",
    accelerator: "CommandOrControl+Enter",
  },
  {
    id: "deleteLastShot",
    label: "删除最后一张截图",
    description: "删除当前组最后加入的截图",
    group: "截图与处理",
    accelerator: "CommandOrControl+L",
  },
  {
    id: "toggleListening",
    label: "收音开关",
    description: "开始或暂停麦克风与系统声音转写",
    group: "截图与处理",
    accelerator: "CommandOrControl+M",
  },
  {
    id: "answerQuestion",
    label: "回答问题",
    description: "按最近一条对方发言立即生成回答",
    group: "截图与处理",
    accelerator: "CommandOrControl+G",
  },
  {
    id: "voiceSolve",
    label: "语音解题",
    description: "按最近一条自己的发言生成回答",
    group: "截图与处理",
    accelerator: "CommandOrControl+J",
  },
  {
    id: "pagePrev",
    label: "上一组 / 上一页",
    description: "切换到上一组截图与解答",
    group: "导航",
    accelerator: "CommandOrControl+,",
  },
  {
    id: "pageNext",
    label: "下一组 / 下一页",
    description: "切换到下一组截图与解答",
    group: "导航",
    accelerator: "CommandOrControl+.",
  },
  {
    id: "scrollUp",
    label: "解答上滚",
    description: "向上滚动当前解答",
    group: "导航",
    accelerator: "CommandOrControl+;",
  },
  {
    id: "scrollDown",
    label: "解答下滚",
    description: "向下滚动当前解答",
    group: "导航",
    accelerator: "CommandOrControl+'",
  },
  {
    id: "resetView",
    label: "重置视图",
    description: "恢复默认缩放并回到工作台",
    group: "导航",
    accelerator: "CommandOrControl+R",
  },
  {
    id: "moveLeft",
    label: "窗口左移",
    description: "保持尺寸把窗口向左移动",
    group: "窗口与显示",
    accelerator: "CommandOrControl+Left",
  },
  {
    id: "moveRight",
    label: "窗口右移",
    description: "保持尺寸把窗口向右移动",
    group: "窗口与显示",
    accelerator: "CommandOrControl+Right",
  },
  {
    id: "moveUp",
    label: "窗口上移",
    description: "保持尺寸把窗口向上移动",
    group: "窗口与显示",
    accelerator: "CommandOrControl+Up",
  },
  {
    id: "moveDown",
    label: "窗口下移",
    description: "保持尺寸把窗口向下移动",
    group: "窗口与显示",
    accelerator: "CommandOrControl+Down",
  },
  {
    id: "opacityDown",
    label: "降低透明度",
    description: "让浮层更透明一点",
    group: "窗口与显示",
    accelerator: "CommandOrControl+[",
  },
  {
    id: "opacityUp",
    label: "提高透明度",
    description: "让浮层更不透明一点",
    group: "窗口与显示",
    accelerator: "CommandOrControl+]",
  },
  {
    id: "zoomOut",
    label: "缩小界面",
    description: "按 10% 步进缩小界面",
    group: "窗口与显示",
    accelerator: "CommandOrControl+-",
  },
  {
    id: "zoomReset",
    label: "重置缩放",
    description: "把界面缩放恢复到 100%",
    group: "窗口与显示",
    accelerator: "CommandOrControl+0",
  },
  {
    id: "zoomIn",
    label: "放大界面",
    description: "按 10% 步进放大界面",
    group: "窗口与显示",
    accelerator: "CommandOrControl+=",
  },
  {
    id: "toggleClickThrough",
    label: "点击穿透",
    description: "旧版兼容项，始终默认开启",
    group: "窗口与显示",
    accelerator: "CommandOrControl+Shift+T",
    hidden: true,
  },
];

export function defaultHotkeys(): HotkeySettings {
  const result = {} as HotkeySettings;
  for (const definition of HOTKEY_DEFINITIONS) result[definition.id] = definition.accelerator;
  return result;
}

export function visibleHotkeyDefinitions(): HotkeyDefinition[] {
  return HOTKEY_DEFINITIONS.filter((definition) => !definition.hidden);
}

const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
};

export type KeyboardLike = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export function acceleratorFromKeyboard(event: KeyboardLike, platform = "win32"): string {
  const key = event.key;
  if (["Control", "Meta", "Alt", "Shift", "CapsLock"].includes(key)) return "";
  const parts: string[] = [];
  if (platform === "darwin" ? event.metaKey : event.ctrlKey) {
    parts.push("CommandOrControl");
  } else if (platform === "darwin" && event.ctrlKey) {
    parts.push("Control");
  } else if (platform !== "darwin" && event.metaKey) {
    parts.push("Super");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  let name = KEY_LABELS[key] ?? key;
  if (name.length === 1 && /[a-z]/i.test(name)) name = name.toUpperCase();
  if (name === "+") name = "Plus";
  if (!name) return "";
  parts.push(name);
  return parts.join("+");
}

export function formatAccelerator(accelerator: string, platform = "win32"): string {
  if (!accelerator) return "";
  const mac = platform === "darwin";
  return accelerator
    .split("+")
    .map((part) => {
      switch (part) {
        case "CommandOrControl":
          return mac ? "⌘" : "Ctrl";
        case "Control":
          return mac ? "⌃" : "Ctrl";
        case "Command":
        case "Cmd":
          return "⌘";
        case "Alt":
          return mac ? "⌥" : "Alt";
        case "Shift":
          return mac ? "⇧" : "Shift";
        case "Plus":
          return "+";
        default:
          return part;
      }
    })
    .join(mac ? "" : "+");
}

export function hotkeyActionLabel(id: HotkeyActionId): string {
  return HOTKEY_DEFINITIONS.find((definition) => definition.id === id)?.label ?? id;
}

const LEGACY_DEFAULTS: Partial<Record<HotkeyActionId, string[]>> = {
  toggleOverlay: ["Control+Shift+Space", "Ctrl+Shift+Space"],
  captureRegion: ["Control+Shift+S", "Ctrl+Shift+S", "CTRL+SHIFT+S"],
  toggleListening: ["Control+Shift+R", "Ctrl+Shift+R", "CTRL+SHIFT+R"],
};

function canonicalAccelerator(value: string): string {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control") return "Control";
      if (lower === "cmd" || lower === "command") return "Command";
      if (lower === "cmdorctrl" || lower === "commandorcontrol") return "CommandOrControl";
      if (lower === "option") return "Alt";
      if (lower === "alt") return "Alt";
      if (lower === "shift") return "Shift";
      return part.length === 1 ? part.toUpperCase() : part;
    });
  const modifiers = parts.filter((part) => MODIFIER_NAMES.has(part));
  const keys = parts.filter((part) => !MODIFIER_NAMES.has(part));
  return [...new Set(modifiers), ...keys].join("+");
}

const MODIFIER_NAMES = new Set([
  "CommandOrControl",
  "Command",
  "Control",
  "Alt",
  "Shift",
  "Super",
]);

export function normalizeAccelerator(value: string): string {
  return canonicalAccelerator(value);
}

/**
 * Electron's Windows globalShortcut implementation only accepts concrete
 * modifiers. `CommandOrControl` works for menu accelerators but is rejected
 * by RegisterHotKey, so resolve it before registration.
 */
export function toGlobalAccelerator(value: string, platform = "win32"): string {
  const mac = platform === "darwin";
  return canonicalAccelerator(value)
    .split("+")
    .filter(Boolean)
    .map((part) => {
      if (part === "CommandOrControl") return mac ? "Command" : "Control";
      if (part === "Command" && !mac) return "Control";
      return part;
    })
    .join("+");
}

/**
 * Migrates the hotkey defaults shipped before the workbench redesign while
 * leaving any other user customization untouched.
 */
export function normalizeHotkeySettings(hotkeys: HotkeySettings): HotkeySettings {
  const result = { ...hotkeys };
  for (const definition of HOTKEY_DEFINITIONS) {
    const value = canonicalAccelerator(result[definition.id] ?? definition.accelerator);
    const legacy = LEGACY_DEFAULTS[definition.id];
    if (legacy && legacy.some((entry) => canonicalAccelerator(entry) === canonicalAccelerator(value))) {
      result[definition.id] = definition.accelerator;
    } else {
      result[definition.id] = value;
    }
  }
  return result;
}
