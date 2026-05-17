# automateLinuxTerminal

A terminal emulator built with Ink. The app embeds a real shell inside an Ink layout, so widgets (clock, status, etc.) live alongside the terminal as React components.

## Rules

- **Ink only.** All UI must be built with Ink components (`<Box>`, `<Text>`, hooks). No raw ANSI escape codes, ncurses, blessed, or other terminal rendering.
- The shell is embedded via `node-pty` + `@xterm/headless`. Pty output is parsed by xterm into a screen buffer, then rendered through Ink's React tree.
- Widgets are standard Ink/React components placed around the terminal area.

## Stack

- React + Ink (terminal UI framework)
- node-pty (pseudo-terminal for the embedded shell)
- @xterm/headless (terminal emulation / ANSI parser)
- TypeScript, run with `tsx`

## Run

```bash
npm start
```

Type `exit` in the embedded shell to quit.

## Context Menus (right-click)

Two right-click menus exist, rendered as absolutely-positioned Ink overlays with box-drawing borders (`ContextMenuOverlay` in `app.tsx`):

1. **`automateLinuxTerminalMenu`** — triggered by right-clicking the clock/status area. Shows the active Claude session ID (first 8 chars) and Claude's working directory. Items are hover-highlighted.
2. **`clipboard`** — triggered by right-clicking the terminal area. Provides Copy (disabled if no selection) and Paste.
