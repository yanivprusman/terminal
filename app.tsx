import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useStdin } from "ink";
import { spawn, execFileSync } from "child_process";
import { readFileSync } from "fs";
import pty from "node-pty";
import xterm from "@xterm/headless";
const { Terminal: XTerminal } = xterm;

// ── Color conversion ────────────────────────────────────
// xterm buffer cells store colors as mode + value.
// We convert them to hex strings that Ink's <Text> understands.

const ANSI_COLORS = [
  "#000000", "#cc0000", "#4e9a06", "#c4a000",
  "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f",
  "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

function palette256(idx: number): string {
  if (idx < 16) return ANSI_COLORS[idx];
  if (idx < 232) {
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor(i / 6) % 6;
    const b = i % 6;
    const v = (n: number) => (n === 0 ? 0 : 55 + 40 * n);
    return "#" + [r, g, b].map((n) => v(n).toString(16).padStart(2, "0")).join("");
  }
  const v = 8 + 10 * (idx - 232);
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

interface ColorCell {
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  isFgDefault(): boolean;
  getFgColor(): number;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  isBgDefault(): boolean;
  getBgColor(): number;
}

function fgColor(cell: ColorCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgPalette()) return palette256(cell.getFgColor());
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    return "#" + ((c >> 16) & 0xff).toString(16).padStart(2, "0")
      + ((c >> 8) & 0xff).toString(16).padStart(2, "0")
      + (c & 0xff).toString(16).padStart(2, "0");
  }
  return undefined;
}

function bgColor(cell: ColorCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgPalette()) return palette256(cell.getBgColor());
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    return "#" + ((c >> 16) & 0xff).toString(16).padStart(2, "0")
      + ((c >> 8) & 0xff).toString(16).padStart(2, "0")
      + (c & 0xff).toString(16).padStart(2, "0");
  }
  return undefined;
}

// ── Span types ──────────────────────────────────────────
// We group consecutive cells with identical attributes into spans,
// so one <Text> per style run instead of one per character.

interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

type Line = Span[];

interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function normalizeSelection(sel: Selection): Selection {
  if (sel.startRow < sel.endRow || (sel.startRow === sel.endRow && sel.startCol <= sel.endCol))
    return sel;
  return { startRow: sel.endRow, startCol: sel.endCol, endRow: sel.startRow, endCol: sel.startCol };
}

function isCellSelected(row: number, col: number, sel: Selection): boolean {
  const n = normalizeSelection(sel);
  if (row < n.startRow || row > n.endRow) return false;
  if (row === n.startRow && row === n.endRow) return col >= n.startCol && col <= n.endCol;
  if (row === n.startRow) return col >= n.startCol;
  if (row === n.endRow) return col <= n.endCol;
  return true;
}

interface ContextMenuState {
  kind: 'clipboard' | 'session';
  row: number;
  col: number;
  hasSelection: boolean;
  hoverItem: number;
  claudeSessionId: string | null;
}

const EMPTY_SPAN: Span = { text: " ", bold: false, dim: false, italic: false, underline: false, strikethrough: false };

function spansEqual(a: Span[], b: Span[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text ||
        a[i].fg !== b[i].fg || a[i].bg !== b[i].bg ||
        a[i].bold !== b[i].bold || a[i].dim !== b[i].dim ||
        a[i].italic !== b[i].italic || a[i].underline !== b[i].underline ||
        a[i].strikethrough !== b[i].strikethrough) return false;
  }
  return true;
}

function detectClaudeSession(shellPid: number): string | null {
  let pids: number[];
  try {
    const output = execFileSync('pgrep', ['-x', 'claude'], { encoding: 'utf-8', timeout: 1000 });
    pids = output.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return null;
  }
  for (const pid of pids) {
    let current = pid;
    for (let i = 0; i < 10; i++) {
      try {
        const stat = readFileSync(`/proc/${current}/stat`, 'utf-8');
        const ppid = parseInt(stat.split(') ')[1]?.split(' ')[1] || '0');
        if (ppid === shellPid) {
          try {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
            const args = cmdline.split('\0').filter(Boolean);
            for (let j = 0; j < args.length; j++) {
              if ((args[j] === '--session-id' || args[j] === '-r') && args[j + 1]) {
                return args[j + 1];
              }
            }
          } catch {}
          return 'unknown';
        }
        if (ppid <= 1) break;
        current = ppid;
      } catch { break; }
    }
  }
  return null;
}

function readBufferRow(
  term: InstanceType<typeof XTerminal>,
  absY: number,
  cols: number,
  cursorVisible: boolean,
  cursorRow: number,
  cursorCol: number,
  viewportRow: number,
  selection?: Selection | null,
): Span[] {
  const bufLine = term.buffer.active.getLine(absY);
  if (!bufLine) return [EMPTY_SPAN];

  const spans: Span[] = [];
  let cur: Span | null = null;

  for (let x = 0; x < cols; x++) {
    const cell = bufLine.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || " ";
    const inverse = cell.isInverse() !== 0;
    const rawFg = fgColor(cell);
    const rawBg = bgColor(cell);
    let fg = inverse ? rawBg : rawFg;
    let bg = inverse ? rawFg : rawBg;

    if (cursorVisible && viewportRow === cursorRow && x === cursorCol) {
      const t = fg;
      fg = bg || "#000000";
      bg = t || "#d3d7cf";
    }
    if (selection && isCellSelected(viewportRow, x, selection)) {
      fg = "#ffffff";
      bg = "#3465a4";
    }
    const bold = cell.isBold() !== 0;
    const dim = cell.isDim() !== 0;
    const italic = cell.isItalic() !== 0;
    const underline = cell.isUnderline() !== 0;
    const strikethrough = cell.isStrikethrough() !== 0;

    if (
      cur &&
      cur.fg === fg && cur.bg === bg &&
      cur.bold === bold && cur.dim === dim &&
      cur.italic === italic && cur.underline === underline &&
      cur.strikethrough === strikethrough
    ) {
      cur.text += chars;
    } else {
      cur = { text: chars, fg, bg, bold, dim, italic, underline, strikethrough };
      spans.push(cur);
    }
  }

  if (spans.length === 0) return [EMPTY_SPAN];
  return spans;
}

function readBuffer(term: InstanceType<typeof XTerminal>, rows: number, cols: number, cache: Line[], selection?: Selection | null, cursorVisible = true): Line[] {
  const buf = term.buffer.active;
  const startY = buf.viewportY;
  const cursorRow = buf.cursorY + buf.baseY - startY;
  const cursorCol = buf.cursorX;
  const lines: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const row = readBufferRow(term, startY + y, cols, cursorVisible, cursorRow, cursorCol, y, selection);
    if (cache[y] && spansEqual(cache[y], row)) {
      lines.push(cache[y]);
    } else {
      lines.push(row);
    }
  }
  return lines;
}

// ── Components ──────────────────────────────────────────

function Clock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  const date = now.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return (
    <Text>
      <Text color="cyan" bold>{time}</Text>
      <Text dimColor> {date}</Text>
    </Text>
  );
}

const TerminalLine = React.memo(function TerminalLine({ spans }: { spans: Span[] }) {
  return (
    <Text wrap="truncate">
      {spans.map((s, i) => (
        <Text
          key={i}
          color={s.fg}
          backgroundColor={s.bg}
          bold={s.bold}
          dimColor={s.dim}
          italic={s.italic}
          underline={s.underline}
          strikethrough={s.strikethrough}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
});

const SESSION_MENU_INNER = 20;
const sessionMenuPad = (s: string) => (s + " ".repeat(SESSION_MENU_INNER)).slice(0, SESSION_MENU_INNER);
const sessionMenuBorder = "─".repeat(SESSION_MENU_INNER);

function ContextMenuOverlay({ menu }: { menu: ContextMenuState }) {
  if (menu.kind === 'session') {
    const sessionText = menu.claudeSessionId
      ? `session: ${menu.claudeSessionId.slice(0, 8)}`
      : "no claude session";
    const sessionColor = menu.claudeSessionId ? "#8ae234" : "#666666";
    return (
      <Box position="absolute" marginTop={menu.row} marginLeft={menu.col} flexDirection="column">
        <Text backgroundColor="#2d2d2d" color="#888888">{`╭${sessionMenuBorder}╮`}</Text>
        <Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
          <Text backgroundColor={menu.hoverItem === 0 ? "#3465a4" : "#2d2d2d"} color={sessionColor}>{sessionMenuPad(` ${sessionText}`)}</Text>
          <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        </Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{`╰${sessionMenuBorder}╯`}</Text>
      </Box>
    );
  }
  const copyColor = menu.hasSelection ? "#ffffff" : "#666666";
  return (
    <Box position="absolute" marginTop={menu.row} marginLeft={menu.col} flexDirection="column">
      <Text backgroundColor="#2d2d2d" color="#888888">{"╭────────╮"}</Text>
      <Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        <Text backgroundColor={menu.hoverItem === 0 ? "#3465a4" : "#2d2d2d"} color={copyColor}>{" Copy   "}</Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      </Text>
      <Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
        <Text backgroundColor={menu.hoverItem === 1 ? "#3465a4" : "#2d2d2d"} color="#ffffff">{" Paste  "}</Text>
        <Text backgroundColor="#2d2d2d" color="#888888">{"│"}</Text>
      </Text>
      <Text backgroundColor="#2d2d2d" color="#888888">{"╰────────╯"}</Text>
    </Box>
  );
}

function TerminalEmulator({ rows, cols }: { rows: number; cols: number }) {
  const { stdin, setRawMode } = useStdin();
  const [lines, setLines] = useState<Line[]>(() =>
    Array.from({ length: rows }, () => [
      { text: " ", bold: false, dim: false, italic: false, underline: false, strikethrough: false },
    ])
  );
  const needsRefresh = useRef(false);
  const selection = useRef<Selection | null>(null);
  const termRef = useRef<InstanceType<typeof XTerminal> | null>(null);
  const shellRef = useRef<pty.IPty | null>(null);
  const dimsRef = useRef({ rows, cols });
  const cursorVisible = useRef(true);
  const lastCursorPos = useRef({ row: -1, col: -1 });
  const contentDirty = useRef(true);
  const contentCache = useRef<Line[]>([]);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<ContextMenuState | null>(null);

  useEffect(() => {
    if (dimsRef.current.rows === rows && dimsRef.current.cols === cols && termRef.current) return;
    dimsRef.current = { rows, cols };
    if (termRef.current && shellRef.current) {
      termRef.current.resize(cols, rows);
      shellRef.current.resize(cols, rows);
      contentDirty.current = true;
      needsRefresh.current = true;
    }
  }, [rows, cols]);

  useEffect(() => {
    setRawMode(true);

    const term = new XTerminal({ rows, cols, scrollback: 500, allowProposedApi: true });
    termRef.current = term;

    const shellPath = process.env.SHELL || "bash";
    const shell = pty.spawn(shellPath, ["--login"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATE_LINUX_TERMINAL: "1" } as Record<string, string>,
    });
    shellRef.current = shell;

    shell.onData((data: string) => {
      term.write(data, () => {
        contentDirty.current = true;
        needsRefresh.current = true;
      });
    });

    const blinkId = setInterval(() => {
      cursorVisible.current = !cursorVisible.current;
      needsRefresh.current = true;
    }, 1000);

    const refreshId = setInterval(() => {
      if (!needsRefresh.current) return;
      needsRefresh.current = false;
      const d = dimsRef.current;
      const buf = term.buffer.active;
      const curRow = buf.cursorY + buf.baseY - buf.viewportY;
      const curCol = buf.cursorX;
      if (curRow !== lastCursorPos.current.row || curCol !== lastCursorPos.current.col) {
        lastCursorPos.current = { row: curRow, col: curCol };
        cursorVisible.current = true;
        contentDirty.current = true;
      }
      const cached = contentCache.current;
      let newLines: Line[];
      if (contentDirty.current || cached.length !== d.rows) {
        contentDirty.current = false;
        newLines = readBuffer(term, d.rows, d.cols, cached, selection.current, cursorVisible.current);
      } else {
        const startY = buf.viewportY;
        const cursorRow = readBufferRow(term, startY + curRow, d.cols, cursorVisible.current, curRow, curCol, curRow, selection.current);
        if (cached[curRow] && spansEqual(cached[curRow], cursorRow)) return;
        newLines = cached.slice();
        newLines[curRow] = cursorRow;
      }
      let anyChanged = cached.length !== newLines.length;
      if (!anyChanged) {
        for (let i = 0; i < newLines.length; i++) {
          if (newLines[i] !== cached[i]) { anyChanged = true; break; }
        }
      }
      if (!anyChanged) return;
      contentCache.current = newLines;
      setLines(newLines);
    }, 50);

    process.stdout.write('\x1b[?1002h\x1b[?1006h');

    let inBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBuf = () => {
      if (inBuf) {
        shell.write(inBuf);
        inBuf = '';
      }
    };

    const copySelectionToClipboard = () => {
      if (!selection.current) return;
      const sel = normalizeSelection(selection.current);
      if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) return;
      const buf = term.buffer.active;
      const textLines: string[] = [];
      for (let y = sel.startRow; y <= sel.endRow; y++) {
        const line = buf.getLine(buf.viewportY + y);
        if (!line) { textLines.push(''); continue; }
        const sx = y === sel.startRow ? sel.startCol : 0;
        const ex = y === sel.endRow ? sel.endCol : dimsRef.current.cols - 1;
        let t = '';
        for (let x = sx; x <= ex; x++) {
          const cell = line.getCell(x);
          t += cell ? (cell.getChars() || ' ') : ' ';
        }
        textLines.push(t.trimEnd());
      }
      const text = textLines.join('\n');
      if (text.trim()) {
        const clip = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
        clip.stdin.end(text);
      }
      selection.current = null;
      needsRefresh.current = true;
    };

    const pasteFromClipboard = () => {
      const clip = spawn("xclip", ["-selection", "clipboard", "-o"], { stdio: ["ignore", "pipe", "ignore"] });
      let data = '';
      clip.stdout.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      clip.on('close', () => {
        if (data && shellRef.current) {
          shellRef.current.write(data);
        }
      });
    };

    const openMenu = (row: number, col: number) => {
      const d = dimsRef.current;
      const isClockRegion = row === 0 && col >= d.cols - 22;
      if (isClockRegion) {
        const menuH = 3, menuW = SESSION_MENU_INNER + 2;
        const r = Math.max(0, Math.min(row, d.rows - menuH));
        const c = Math.max(0, Math.min(col, d.cols - menuW));
        const claudeSessionId = detectClaudeSession(shell.pid);
        ctxMenuRef.current = { kind: 'session', row: r, col: c, hasSelection: false, hoverItem: -1, claudeSessionId };
      } else {
        const menuH = 4, menuW = 10;
        const r = Math.max(0, Math.min(row, d.rows - menuH));
        const c = Math.max(0, Math.min(col, d.cols - menuW));
        const hasSel = !!selection.current && (() => {
          const s = normalizeSelection(selection.current!);
          return !(s.startRow === s.endRow && s.startCol === s.endCol);
        })();
        ctxMenuRef.current = { kind: 'clipboard', row: r, col: c, hasSelection: hasSel, hoverItem: -1, claudeSessionId: null };
      }
      setCtxMenu({ ...ctxMenuRef.current });
      process.stdout.write('\x1b[?1003h');
    };

    const closeMenu = () => {
      if (!ctxMenuRef.current) return;
      ctxMenuRef.current = null;
      setCtxMenu(null);
      process.stdout.write('\x1b[?1003l');
    };

    const processInput = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

      if (ctxMenuRef.current) {
        let pos = 0;
        while (pos < inBuf.length) {
          if (inBuf[pos] === '\x1b') {
            const rest = inBuf.slice(pos);
            const sgrMatch = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
            if (sgrMatch) {
              const button = parseInt(sgrMatch[1]);
              const mCol = parseInt(sgrMatch[2]) - 1;
              const mRow = parseInt(sgrMatch[3]) - 1;
              const isPress = sgrMatch[4] === 'M';
              const m = ctxMenuRef.current!;
              const rowOff = mRow - m.row;
              let itemIdx: number;
              let menuW: number;
              if (m.kind === 'session') {
                itemIdx = rowOff === 1 ? 0 : -1;
                menuW = SESSION_MENU_INNER;
              } else {
                itemIdx = rowOff === 1 ? 0 : rowOff === 2 ? 1 : -1;
                menuW = 8;
              }
              const onItem = itemIdx >= 0 && (mCol - m.col) >= 1 && (mCol - m.col) <= menuW;
              if (button === 35 || button === 32 || button === 34) {
                const h = onItem ? itemIdx : -1;
                if (h !== m.hoverItem) {
                  const updated: ContextMenuState = { ...m, hoverItem: h };
                  ctxMenuRef.current = updated;
                  setCtxMenu(updated);
                }
              } else if (button === 0 && isPress) {
                if (m.kind === 'clipboard') {
                  if (onItem && itemIdx === 0 && m.hasSelection) copySelectionToClipboard();
                  else if (onItem && itemIdx === 1) pasteFromClipboard();
                } else if (m.kind === 'session' && onItem && itemIdx === 0 && m.claudeSessionId) {
                  const clip = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
                  clip.stdin.end(m.claudeSessionId);
                }
                closeMenu();
              } else if (button === 2 && isPress) {
                closeMenu();
                openMenu(mRow, mCol);
              } else if (button === 64 || button === 65) {
                closeMenu();
              }
              pos += sgrMatch[0].length; continue;
            }
            if (/^\x1b(\[(<([\d;]*)?)?)?$/.test(rest)) {
              inBuf = rest;
              flushTimer = setTimeout(() => { closeMenu(); inBuf = ''; }, 50);
              return;
            }
            closeMenu(); inBuf = ''; return;
          }
          closeMenu(); inBuf = ''; return;
        }
        inBuf = ''; return;
      }

      let pos = 0;
      while (pos < inBuf.length) {
        if (inBuf[pos] === '\x1b') {
          const rest = inBuf.slice(pos);

          if (rest.startsWith('\x1b[5;2~')) {
            term.scrollPages(-1);
            contentDirty.current = true;
            needsRefresh.current = true;
            pos += 6; continue;
          }
          if (rest.startsWith('\x1b[6;2~')) {
            term.scrollPages(1);
            contentDirty.current = true;
            needsRefresh.current = true;
            pos += 6; continue;
          }

          const sgrMatch = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (sgrMatch) {
            const button = parseInt(sgrMatch[1]);
            const mCol = parseInt(sgrMatch[2]) - 1;
            const mRow = parseInt(sgrMatch[3]) - 1;
            const isPress = sgrMatch[4] === 'M';

            if (button === 64) { term.scrollLines(-3); contentDirty.current = true; needsRefresh.current = true; }
            else if (button === 65) { term.scrollLines(3); contentDirty.current = true; needsRefresh.current = true; }
            else if (button === 2) {
              if (isPress) openMenu(mRow, mCol);
            }
            else if (term.modes.mouseTrackingMode !== 'none') {
              shell.write(sgrMatch[0]);
            }
            else if (button === 0 && isPress) {
              const d = dimsRef.current;
              const r = Math.max(0, Math.min(mRow, d.rows - 1));
              const c = Math.max(0, Math.min(mCol, d.cols - 1));
              selection.current = { startRow: r, startCol: c, endRow: r, endCol: c };
              contentDirty.current = true;
              needsRefresh.current = true;
            }
            else if (button === 32 && isPress && selection.current) {
              const d = dimsRef.current;
              selection.current.endRow = Math.max(0, Math.min(mRow, d.rows - 1));
              selection.current.endCol = Math.max(0, Math.min(mCol, d.cols - 1));
              contentDirty.current = true;
              needsRefresh.current = true;
            }
            else if (button === 0 && !isPress && selection.current) {
              const sel = normalizeSelection(selection.current);
              if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) {
                selection.current = null;
                contentDirty.current = true;
                needsRefresh.current = true;
              }
            }
            pos += sgrMatch[0].length; continue;
          }

          let complete = false;
          if (rest.length === 1) {
            // just \x1b — could be incomplete
          } else if (rest[1] !== '[') {
            complete = true; // \x1bX — two-char escape
          } else {
            for (let i = 2; i < rest.length; i++) {
              const c = rest.charCodeAt(i);
              if (c >= 0x40 && c <= 0x7e) { complete = true; break; }
            }
          }

          if (!complete) {
            inBuf = rest;
            flushTimer = setTimeout(flushBuf, 50);
            return;
          }

          const escMatch = rest.match(/^\x1b(\[[\x20-\x3f]*[\x40-\x7e]|[^\[])/);
          if (escMatch) {
            shell.write(escMatch[0]);
            pos += escMatch[0].length; continue;
          }
          shell.write(inBuf[pos]);
          pos++; continue;
        }

        if (inBuf[pos] === '\x03' && selection.current) {
          const sel = normalizeSelection(selection.current);
          if (!(sel.startRow === sel.endRow && sel.startCol === sel.endCol)) {
            copySelectionToClipboard();
            pos++; continue;
          }
        }

        let end = pos + 1;
        while (end < inBuf.length && inBuf[end] !== '\x1b') end++;

        if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
          term.scrollToBottom();
          contentDirty.current = true;
          needsRefresh.current = true;
        }
        if (selection.current) { selection.current = null; contentDirty.current = true; needsRefresh.current = true; }
        shell.write(inBuf.slice(pos, end));
        pos = end;
      }
      inBuf = '';
    };

    const handleInput = (data: Buffer) => {
      inBuf += data.toString();
      processInput();
    };
    stdin?.on("data", handleInput);

    shell.onExit(() => {
      process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1003l');
      clearInterval(refreshId);
      clearInterval(blinkId);
      process.exit(0);
    });

    return () => {
      process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1003l');
      clearInterval(refreshId);
      clearInterval(blinkId);
      if (flushTimer) clearTimeout(flushTimer);
      stdin?.off("data", handleInput);
      shell.kill();
      term.dispose();
      termRef.current = null;
      shellRef.current = null;
    };
  }, []);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((spans, i) => (
        <TerminalLine key={i} spans={spans} />
      ))}
      {ctxMenu && <ContextMenuOverlay menu={ctxMenu} />}
    </Box>
  );
}

function AutomateLinuxTerminal() {
  const { stdout } = useStdout();
  const [dims, setDims] = useState(() => ({
    cols: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));

  useEffect(() => {
    const onResize = () => {
      setDims({
        cols: stdout?.columns || 80,
        rows: stdout?.rows || 24,
      });
    };
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  return (
    <Box width={dims.cols} height={dims.rows}>
      <TerminalEmulator rows={dims.rows} cols={dims.cols} />
      <Box position="absolute" marginLeft={dims.cols - 22} paddingRight={1}>
        <Clock />
      </Box>
    </Box>
  );
}

render(<AutomateLinuxTerminal />, { exitOnCtrlC: false });
