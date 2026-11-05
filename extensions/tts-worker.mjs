// Speaks text in a child process: synthesis blocks the event loop and sherpa-onnx logs to stderr,
// so both stay away from pi. The parent sends segments already split by language; this process
// synthesizes each one with the matching Piper voice and plays it with the OS audio player,
// preparing the next segment while the current one plays.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const engines = new Map();
const workDir = mkdtempSync(join(tmpdir(), "pi-voice-tts-"));
let generation = 0;
let player;

function engine(voice) {
	let tts = engines.get(voice.model);
	if (!tts) {
		tts = new sherpa.OfflineTts({
			model: { vits: { model: voice.model, tokens: voice.tokens, dataDir: voice.dataDir }, numThreads: 2, debug: false, provider: "cpu" },
			maxNumSentences: 1,
		});
		engines.set(voice.model, tts);
	}
	return tts;
}

function synthesize(segment, voices, speed, index) {
	const audio = engine(voices[segment.lang]).generate({ text: segment.text, sid: 0, speed });
	const file = join(workDir, `${generation}-${index}.wav`);
	sherpa.writeWave(file, { samples: audio.samples, sampleRate: audio.sampleRate });
	return file;
}

const PLAYERS = {
	darwin: [["afplay"]],
	win32: [["powershell", "-NoProfile", "-Command", (file) => `(New-Object Media.SoundPlayer '${file}').PlaySync()`]],
	linux: [["paplay"], ["pw-play"], ["aplay", "-q"]],
};

function play(file) {
	const candidates = PLAYERS[process.platform] ?? PLAYERS.linux;
	return new Promise((resolve, reject) => {
		const attempt = (i) => {
			if (i >= candidates.length) return reject(new Error("no audio player found (afplay, paplay, pw-play or aplay)"));
			const [cmd, ...rest] = candidates[i];
			const args = rest.length && typeof rest.at(-1) === "function" ? [...rest.slice(0, -1), rest.at(-1)(file)] : [...rest, file];
			player = spawn(cmd, args, { stdio: "ignore" });
			player.once("error", (error) => (error.code === "ENOENT" ? attempt(i + 1) : reject(error)));
			player.once("exit", () => resolve());
		};
		attempt(0);
	});
}

async function speak(message) {
	const mine = ++generation;
	try {
		let next = synthesize(message.segments[0], message.voices, message.speed, 0);
		for (let i = 0; i < message.segments.length && mine === generation; i++) {
			const current = next;
			const playing = play(current);
			// Synthesis is synchronous; doing it while the player runs hides its latency.
			next = i + 1 < message.segments.length ? synthesize(message.segments[i + 1], message.voices, message.speed, i + 1) : undefined;
			await playing;
			rmSync(current, { force: true });
		}
		if (next) rmSync(next, { force: true });
		if (mine === generation) process.send({ type: "done", id: message.id });
	} catch (error) {
		process.send({ type: "error", id: message.id, message: String(error?.message ?? error) });
	}
}

function stop() {
	generation++;
	player?.kill();
}

process.on("message", (message) => {
	if (message.type === "speak") {
		stop();
		void speak(message);
	} else if (message.type === "stop") {
		stop();
	}
});

process.on("disconnect", () => {
	stop();
	rmSync(workDir, { recursive: true, force: true });
	process.exit(0);
});
