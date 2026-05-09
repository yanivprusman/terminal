import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useStdin } from "ink";
import { spawn } from "child_process";
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

function readBuffer(term: InstanceType<typeof XTerminal>, rows: number, cols: number, selection?: Selection | null): Line[] {
  const buf = term.buffer.active;
  const lines: Line[] = [];
  const startY = buf.viewportY;
  const cursorRow = buf.cursorY + buf.baseY - startY;
  const cursorCol = buf.cursorX;

  for (let y = 0; y < rows; y++) {
    const bufLine = buf.getLine(startY + y);
    if (!bufLine) {
      lines.push([{ text: " ", bold: false, dim: false, italic: false, underline: false, strikethrough: false }]);
      continue;
    }

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

      if (y === cursorRow && x === cursorCol) {
        const t = fg;
        fg = bg || "#000000";
        bg = t || "#d3d7cf";
      }
      if (selection && isCellSelected(y, x, selection)) {
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

    if (spans.length === 0) {
      spans.push({ text: " ", bold: false, dim: false, italic: false, underline: false, strikethrough: false });
    }
    lines.push(spans);
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

function TerminalLine({ spans }: { spans: Span[] }) {
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

  useEffect(() => {
    setRawMode(true);

    const term = new XTerminal({ rows, cols, allowProposedApi: true });

    const shell = pty.spawn(process.env.SHELL || "bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    shell.onData((data: string) => {
      term.write(data);
      needsRefresh.current = true;
    });

    const refreshId = setInterval(() => {
      if (needsRefresh.current) {
        needsRefresh.current = false;
        setLines(readBuffer(term, rows, cols, selection.current));
      }
    }, 16);

    process.stdout.write('\x1b[?1002h\x1b[?1006h');

    let inBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBuf = () => {
      if (inBuf) {
        shell.write(inBuf);
        inBuf = '';
      }
    };

    const processInput = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      let pos = 0;
      while (pos < inBuf.length) {
        if (inBuf[pos] === '\x1b') {
          const rest = inBuf.slice(pos);

          if (rest.startsWith('\x1b[5;2~')) {
            term.scrollPages(-1);
            needsRefresh.current = true;
            pos += 6; continue;
          }
          if (rest.startsWith('\x1b[6;2~')) {
            term.scrollPages(1);
            needsRefresh.current = true;
            pos += 6; continue;
          }

          const sgrMatch = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (sgrMatch) {
            const button = parseInt(sgrMatch[1]);
            const mCol = parseInt(sgrMatch[2]) - 1;
            const mRow = parseInt(sgrMatch[3]) - 2;
            const isPress = sgrMatch[4] === 'M';

            if (button === 64) { term.scrollLines(-3); needsRefresh.current = true; }
            else if (button === 65) { term.scrollLines(3); needsRefresh.current = true; }
            else if (term.modes.mouseTrackingMode !== 'none') {
              shell.write(sgrMatch[0]);
            }
            else if (button === 0 && isPress) {
              const r = Math.max(0, Math.min(mRow, rows - 1));
              const c = Math.max(0, Math.min(mCol, cols - 1));
              selection.current = { startRow: r, startCol: c, endRow: r, endCol: c };
              needsRefresh.current = true;
            }
            else if (button === 32 && isPress && selection.current) {
              selection.current.endRow = Math.max(0, Math.min(mRow, rows - 1));
              selection.current.endCol = Math.max(0, Math.min(mCol, cols - 1));
              needsRefresh.current = true;
            }
            else if (button === 0 && !isPress && selection.current) {
              const sel = normalizeSelection(selection.current);
              if (sel.startRow === sel.endRow && sel.startCol === sel.endCol) {
                selection.current = null;
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
            const buf = term.buffer.active;
            const textLines: string[] = [];
            for (let y = sel.startRow; y <= sel.endRow; y++) {
              const line = buf.getLine(buf.viewportY + y);
              if (!line) { textLines.push(''); continue; }
              const sx = y === sel.startRow ? sel.startCol : 0;
              const ex = y === sel.endRow ? sel.endCol : cols - 1;
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
          }
          selection.current = null;
          needsRefresh.current = true;
          pos++; continue;
        }

        let end = pos + 1;
        while (end < inBuf.length && inBuf[end] !== '\x1b') end++;

        if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
          term.scrollToBottom();
          needsRefresh.current = true;
        }
        if (selection.current) { selection.current = null; needsRefresh.current = true; }
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
      process.stdout.write('\x1b[?1002l\x1b[?1006l');
      clearInterval(refreshId);
      process.exit(0);
    });

    return () => {
      process.stdout.write('\x1b[?1002l\x1b[?1006l');
      clearInterval(refreshId);
      if (flushTimer) clearTimeout(flushTimer);
      stdin?.off("data", handleInput);
      shell.kill();
      term.dispose();
    };
  }, []);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((spans, i) => (
        <TerminalLine key={i} spans={spans} />
      ))}
    </Box>
  );
}

function InkBox() {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const totalRows = stdout?.rows || 24;
  const termRows = totalRows - 1;

  return (
    <Box flexDirection="column" width={cols} height={totalRows}>
      <Box paddingX={1}>
        <Text bold color="green">InkBox</Text>
        <Box flexGrow={1} />
        <Clock />
      </Box>
      <TerminalEmulator rows={termRows} cols={cols} />
    </Box>
  );
}

render(<InkBox />, { exitOnCtrlC: false });
