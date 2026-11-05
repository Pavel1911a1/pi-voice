# pi-voice

Offline voice input for the [pi](https://pi.dev) coding agent. Press a key, speak Russian or English,
press it again — the text lands in the editor for you to review and send.

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
| Start / stop recording | `alt+m` or `/voice` |
| Switch language for this session | `/voice-lang auto`, `/voice-lang ru`, `/voice-lang en` |
| List microphones | `/voice-devices` |

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
  "maxSeconds": 300
}
```

- `language`: `auto` detects per recording; fix it to `ru` or `en` if detection guesses wrong.
- `vocabulary`: product names and identifiers whisper tends to mishear; they are passed as a hint.
- `device`: index from `/voice-devices`, `-1` for the system default.
- `model` / `modelUrl`: another ggml whisper model, e.g. `ggml-small.bin` for slow machines
  (much weaker in Russian).

Changes apply after `/reload` or a restart of pi.
