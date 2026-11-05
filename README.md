# pi-voice

Offline voice input for the [pi](https://pi.dev) coding agent. Press a key, speak Russian or English,
pause — the text lands in the editor for you to review and send.

Everything runs on your machine: audio is captured with [PvRecorder](https://github.com/Picovoice/pvrecorder)
and transcribed by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) through
[whisper.node](https://github.com/mybigday/whisper.node). No audio or text is sent anywhere.

## Install

```bash
pi install git:github.com/Pavel1911a1/pi-voice
```

No brew, apt or compilers needed: npm picks prebuilt binaries for your OS and CPU
(macOS arm64/x64, Windows x64/arm64, Linux x64). The speech model
(`ggml-large-v3-turbo-q5_0.bin`, ~550 MB) is downloaded once, on first use, into
`~/.pi/agent/voice/models/`.

On first recording the OS asks for microphone access for your **terminal app**
(Terminal, iTerm2, Ghostty, Windows Terminal...). Allow it, then restart the terminal.

## Use

| Action | How |
|---|---|
| Talk | press `alt+m` (or run `/voice`) and speak; recording stops after a 1.5 s pause |
| Hold to talk | hold `alt+m` while speaking, let go to stop (terminals with key release events, see below) |
| Stop early | press `alt+m` again |
| Switch language for this session | `/voice-lang auto`, `/voice-lang ru`, `/voice-lang en` |
| List microphones | `/voice-devices` |

Hold-to-talk needs a terminal that reports key releases through the kitty keyboard protocol:
Ghostty, kitty, WezTerm, Alacritty, foot, or iTerm2 with "Report keys using CSI u". macOS Terminal
and Windows Terminal do not report releases, so there the shortcut works as press-and-pause.

On macOS `alt` shortcuts need "Use Option as Meta key" in the terminal settings
(Terminal: Profiles → Keyboard; iTerm2: Profiles → Keys → Left Option key → Esc+).
Otherwise use `/voice` or pick another shortcut.

## Settings

Optional `~/.pi/agent/voice.json`:

```json
{
  "shortcut": "alt+m",
  "language": "auto",
  "vocabulary": ["Neo4j", "COBOL", "Jira", "pull request"],
  "device": -1,
  "maxSeconds": 300,
  "autoStop": true,
  "silenceMs": 1500
}
```

- `language`: `auto` detects per recording; fix it to `ru` or `en` if detection guesses wrong.
- `vocabulary`: product names and identifiers whisper tends to mishear; they are passed as a hint.
- `autoStop` / `silenceMs`: stop after this much silence; raise `silenceMs` if you pause mid-sentence,
  or set `autoStop` to `false` to always stop with a second press.
- `device`: index from `/voice-devices`, `-1` for the system default.
- `model` / `modelUrl`: another ggml whisper model, e.g. `ggml-small.bin` for slow machines
  (much weaker in Russian).

Changes apply after `/reload` or a restart of pi.
