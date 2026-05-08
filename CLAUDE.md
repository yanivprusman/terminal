# InkBox

A terminal emulator built with Ink. The Ink app **is** the terminal — it embeds a real shell inside an Ink layout, so widgets (clock, status, etc.) live alongside the terminal as React components.

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
