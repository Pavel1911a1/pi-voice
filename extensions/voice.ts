/**
 * Offline voice input for pi.
 *
 * Press the shortcut (default alt+m) or run /voice and speak: recording stops by itself when you
 * pause. In terminals that report key releases (Ghostty, kitty, WezTerm, iTerm2 with CSI u) hold
 * the shortcut while speaking and let go to stop.
 * Speech is transcribed locally with whisper.cpp and pasted into the editor; nothing leaves
 * the machine. The model is downloaded once on first use.
 *
 * With speech output on (/voice-tts), finished replies are read aloud with local Piper voices:
 * Irina for Russian, Amy for English. alt+s stops reading.
 *
 * Settings live in ~/.pi/agent/voice.json, see README.md.
 */

import { type ChildProcess, fork } from "node:child_process";
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import { type SpeechLanguage, type SpeechSegment, toSpeech } from "./speech-text.ts";

type Language = "auto" | "ru" | "en";

interface VoiceConfig {
	shortcut: string;
	language: Language;
	/** Words whisper tends to mishear: product names, abbreviations, identifiers. */
	vocabulary: string[];
	model: string;
	modelUrl?: string;
	/** Input device index from PvRecorder.getAvailableDevices(); -1 is the system default. */
	device: number;
	maxSeconds: number;
	/** Without hold-to-talk, stop recording after this much silence following speech. */
	autoStop: boolean;
	silenceMs: number;
	/** Read finished replies aloud. */
	speak: boolean;
	stopSpeechShortcut: string;
	/** sherpa-onnx Piper voice packages, see https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models */
	voices: Record<SpeechLanguage, string>;
	speechRate: number;
	/** Longer replies are cut at a sentence boundary with "the rest is on screen". */
	maxSpeakChars: number;
}

const DEFAULTS: VoiceConfig = {
	shortcut: "alt+m",
	language: "auto",
	vocabulary: [],
	model: "ggml-large-v3-turbo-q5_0.bin",
	device: -1,
	maxSeconds: 300,
	autoStop: true,
	silenceMs: 1500,
	speak: false,
	stopSpeechShortcut: "alt+s",
	voices: { ru: "vits-piper-ru_RU-irina-medium", en: "vits-piper-en_US-amy-medium" },
	speechRate: 1,
	maxSpeakChars: 1500,
};

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const VOICE_BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";
const STATUS = "voice";
const STOP_SIGNAL = join(getAgentDir(), "voice", "stop-speech");
const FRAME_LENGTH = 512;
// Below this peak amplitude the recording is treated as silence: whisper invents text for it.
const SILENCE_PEAK = 500;
// Frame loudness that counts as speech even in a very quiet room.
const MIN_SPEECH_RMS = 300;
// Auto-stop gives up if nobody starts speaking within this time.
const NO_SPEECH_TIMEOUT_MS = 8000;

function configPath(): string {
	return join(getAgentDir(), "voice.json");
}

function loadConfig(): VoiceConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULTS };
	try {
		const saved = JSON.parse(readFileSync(path, "utf8"));
		return { ...DEFAULTS, ...saved, voices: { ...DEFAULTS.voices, ...saved.voices } };
	} catch {
		return { ...DEFAULTS };
	}
}

/** Writes one setting into voice.json, keeping whatever else the user put there. */
function saveSetting(key: keyof VoiceConfig, value: unknown): void {
	const path = configPath();
	let saved: Record<string, unknown> = {};
	try {
		saved = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	saved[key] = value;
	writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
}

function modelPath(config: VoiceConfig): string {
	return join(getAgentDir(), "voice", "models", config.model);
}

async function downloadModel(config: VoiceConfig, ctx: ExtensionContext): Promise<void> {
	const target = modelPath(config);
	const part = `${target}.part`;
	mkdirSync(dirname(target), { recursive: true });
	const url = config.modelUrl ?? MODEL_BASE_URL + config.model;
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`model download failed: HTTP ${response.status} for ${url}`);

	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	let shown = -1;
	const body = Readable.fromWeb(response.body as any);
	body.on("data", (chunk: Buffer) => {
		received += chunk.length;
		const percent = total ? Math.floor((received / total) * 100) : -1;
		if (percent !== shown) {
			shown = percent;
			const mb = Math.round(received / 1e6);
			ctx.ui.setStatus(STATUS, `voice: downloading model ${percent >= 0 ? `${percent}%` : `${mb} MB`}`);
		}
	});
	try {
		await pipeline(body, createWriteStream(part));
		renameSync(part, target);
	} catch (error) {
		rmSync(part, { force: true });
		throw error;
	}
}

interface VoiceFiles {
	model: string;
	tokens: string;
	dataDir: string;
}

function voiceDir(name: string): string {
	return join(getAgentDir(), "voice", "voices", name);
}

function voiceFiles(name: string): VoiceFiles | undefined {
	const dir = voiceDir(name);
	if (!existsSync(dir)) return undefined;
	const model = readdirSync(dir).find((file) => file.endsWith(".onnx"));
	if (!model) return undefined;
	return { model: join(dir, model), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data") };
}

/** Downloads a voice archive (.tar.bz2) and unpacks it with the system tar (macOS, Linux, Windows 10+). */
async function downloadVoice(name: string, ctx: ExtensionContext): Promise<void> {
	const target = voiceDir(name);
	const part = `${target}.part`;
	rmSync(part, { recursive: true, force: true });
	mkdirSync(part, { recursive: true });
	const response = await fetch(VOICE_BASE_URL + name + ".tar.bz2");
	if (!response.ok || !response.body) throw new Error(`voice download failed: HTTP ${response.status} for ${name}`);
	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	let shown = -1;
	const body = Readable.fromWeb(response.body as any);
	body.on("data", (chunk: Buffer) => {
		received += chunk.length;
		const percent = total ? Math.floor((received / total) * 100) : -1;
		if (percent !== shown) {
			shown = percent;
			ctx.ui.setStatus(STATUS, `voice: downloading ${name.replace("vits-piper-", "")} ${percent >= 0 ? `${percent}%` : ""}`);
		}
	});
	const tar = spawn("tar", ["-xjf", "-", "-C", part, "--strip-components", "1"], { stdio: ["pipe", "ignore", "pipe"] });
	let tarError = "";
	tar.stderr.on("data", (chunk) => (tarError += chunk));
	const exited = new Promise<number | null>((resolve, reject) => {
		tar.once("error", reject);
		tar.once("exit", resolve);
	});
	try {
		await pipeline(body, tar.stdin);
		const code = await exited;
		if (code !== 0) throw new Error(`tar failed (${code}): ${tarError.trim()}`);
		rmSync(target, { recursive: true, force: true });
		renameSync(part, target);
	} catch (error) {
		rmSync(part, { recursive: true, force: true });
		throw error;
	}
}

/** Text of the last assistant message that has any: earlier ones are progress notes between tool calls. */
function lastReplyText(messages: readonly any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = Array.isArray(message.content)
			? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
			: typeof message.content === "string"
				? message.content
				: "";
		if (text.trim()) return text;
	}
	return undefined;
}

function rms(frame: Int16Array): number {
	let sum = 0;
	for (const s of frame) sum += s * s;
	return Math.sqrt(sum / frame.length);
}

// Legacy terminals send Option/Alt+key as ESC + the character of the active layout, so on a
// Russian or Ukrainian layout alt+m arrives as ESC + "ь". Map those back to the QWERTY key.
const CYRILLIC = "йцукенгшщзхъфывапролджэячсмитьбюіїє";
const QWERTY = "qwertyuiop[]asdfghjkl;'zxcvbnm,.s]'";
const CYRILLIC_TO_QWERTY: Record<string, string> = Object.fromEntries([...CYRILLIC].map((c, i) => [c, QWERTY[i]]));
// What macOS Terminal types for Option+letter on the U.S. layout when "Use Option as Meta" is off
// (e, i, n and u are dead keys there and type nothing on their own).
const MAC_OPTION_LETTERS = "abcdfghjklmopqrstvwxyz";
const MAC_OPTION_TYPED = "å∫ç∂ƒ©˙∆˚¬µøπœ®ß†√∑≈¥Ω";
const MAC_OPTION_CHARS: Record<string, string> = Object.fromEntries(
	[...MAC_OPTION_TYPED].map((c, i) => [c, `alt+${MAC_OPTION_LETTERS[i]}`]),
);

function matchesShortcut(data: string, shortcut: string): boolean {
	if (matchesKey(data, shortcut as KeyId)) return true;
	if (MAC_OPTION_CHARS[data] === shortcut) return true;
	if (data.length === 2 && data[0] === "\x1b") {
		const latin = CYRILLIC_TO_QWERTY[data[1].toLowerCase()];
		return latin !== undefined && matchesKey(`\x1b${latin}`, shortcut as KeyId);
	}
	return false;
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(EXTENSION_DIR, "whisper-worker.mjs");
const TTS_WORKER_PATH = join(EXTENSION_DIR, "tts-worker.mjs");

/** whisper.cpp in a child process with stdio ignored, so its native logs never reach pi's screen. */
class WhisperWorker {
	private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
	private nextId = 1;

	private constructor(private readonly child: ChildProcess) {
		child.on("message", (message: any) => {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.type === "result") waiter.resolve(message.text);
			else waiter.reject(new Error(message.message));
		});
		child.on("exit", (code) => {
			for (const waiter of this.pending.values()) waiter.reject(new Error(`speech worker exited (${code})`));
			this.pending.clear();
		});
	}

	static start(model: string): Promise<WhisperWorker> {
		const child = fork(WORKER_PATH, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
		return new Promise((resolve, reject) => {
			child.once("message", (message: any) => {
				if (message.type === "ready") resolve(new WhisperWorker(child));
				else {
					child.kill();
					reject(new Error(message.message));
				}
			});
			child.once("exit", (code) => reject(new Error(`speech worker exited (${code}) while loading the model`)));
			child.send({ type: "init", model });
		});
	}

	get alive(): boolean {
		return this.child.exitCode === null && this.child.connected;
	}

	transcribe(pcm: Int16Array, language: string, prompt: string | undefined): Promise<string> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child.send({ type: "transcribe", id, pcm, language, prompt });
		});
	}

	stop(): void {
		if (this.child.connected) this.child.disconnect();
	}
}

/** Piper voices in a child process: synthesis is CPU-heavy and sherpa-onnx logs to stderr. */
class Speaker {
	private readonly child: ChildProcess;
	private nextId = 1;
	private current = 0;

	constructor(private readonly onFinished: (error?: string) => void) {
		this.child = fork(TTS_WORKER_PATH, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		this.child.on("message", (message: any) => {
			if (message.id !== this.current) return;
			this.current = 0;
			this.onFinished(message.type === "error" ? message.message : undefined);
		});
		this.child.on("exit", () => {
			if (this.current) this.onFinished("speech worker exited");
			this.current = 0;
		});
	}

	get alive(): boolean {
		return this.child.exitCode === null && this.child.connected;
	}

	get speaking(): boolean {
		return this.current !== 0;
	}

	speak(segments: SpeechSegment[], voices: Record<SpeechLanguage, VoiceFiles>, speed: number): void {
		this.current = this.nextId++;
		this.child.send({ type: "speak", id: this.current, segments, voices, speed });
	}

	stop(): void {
		if (!this.current) return;
		this.current = 0;
		this.child.send({ type: "stop" });
	}

	dispose(): void {
		if (this.child.connected) this.child.disconnect();
	}
}

function formatSeconds(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let state: "idle" | "preparing" | "recording" | "transcribing" = "idle";
	// Hold mode: started by a key press in a terminal that reports key releases; stops on release.
	let holding = false;
	let releasedWhilePreparing = false;
	let whisper: WhisperWorker | undefined;
	let recorder: PvRecorder | undefined;
	let frames: Int16Array[] = [];
	let recordingLoop: Promise<void> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let speaker: Speaker | undefined;
	let lastReply: string | undefined;
	let speechCtx: ExtensionContext | undefined;
	let stopWatcher: FSWatcher | undefined;

	function stopSpeaking(): void {
		if (!speaker?.speaking) return;
		speaker.stop();
		speechCtx?.ui.setStatus(STATUS, undefined);
	}

	// Other pi processes speak too (other terminals, the pi-watcher side agent). A stop key or a
	// new recording anywhere silences all of them, and a new reply silences the previous one.
	function stopSpeakingEverywhere(): void {
		stopSpeaking();
		try {
			mkdirSync(dirname(STOP_SIGNAL), { recursive: true });
			writeFileSync(STOP_SIGNAL, `${process.pid} ${Date.now()}`);
		} catch {}
	}

	function watchStopSignal(): void {
		stopWatcher?.close();
		try {
			mkdirSync(dirname(STOP_SIGNAL), { recursive: true });
			stopWatcher = watch(dirname(STOP_SIGNAL), (_event, file) => {
				if (file !== basename(STOP_SIGNAL)) return;
				try {
					if (readFileSync(STOP_SIGNAL, "utf8").split(" ")[0] !== String(process.pid)) stopSpeaking();
				} catch {}
			});
		} catch {}
	}

	async function speakText(ctx: ExtensionContext, markdown: string): Promise<void> {
		const segments = toSpeech(markdown, config.maxSpeakChars);
		if (!segments.length) return;
		speechCtx = ctx;
		try {
			const voices = {} as Record<SpeechLanguage, VoiceFiles>;
			for (const lang of new Set(segments.map((s) => s.lang))) {
				const name = config.voices[lang];
				if (!voiceFiles(name)) {
					ctx.ui.notify(`Downloading voice ${name} (one time, ~65 MB)...`, "info");
					await downloadVoice(name, ctx);
				}
				voices[lang] = voiceFiles(name)!;
			}
			if (state !== "idle") return;
			if (!speaker?.alive) {
				speaker = new Speaker((error) => {
					speechCtx?.ui.setStatus(STATUS, undefined);
					if (error) speechCtx?.ui.notify(`Speech failed: ${error}`, "error");
				});
			}
			stopSpeakingEverywhere();
			ctx.ui.setStatus(STATUS, `🔊 speaking · ${config.stopSpeechShortcut} to stop`);
			speaker.speak(segments, voices, config.speechRate);
		} catch (error) {
			ctx.ui.setStatus(STATUS, undefined);
			ctx.ui.notify(`Speech unavailable: ${(error as Error).message}`, "error");
		}
	}

	async function ensureWhisper(ctx: ExtensionContext): Promise<WhisperWorker> {
		if (whisper?.alive) return whisper;
		if (!existsSync(modelPath(config))) {
			ctx.ui.notify(`Downloading speech model ${config.model} (one time, ~550 MB)...`, "info");
			await downloadModel(config, ctx);
		}
		ctx.ui.setStatus(STATUS, "voice: loading model");
		whisper = await WhisperWorker.start(modelPath(config));
		return whisper;
	}

	async function startRecording(ctx: ExtensionContext, hold: boolean): Promise<void> {
		stopSpeakingEverywhere();
		state = "preparing";
		holding = hold;
		releasedWhilePreparing = false;
		try {
			// Load the model before recording so the first stop does not wait for a download.
			await ensureWhisper(ctx);
			recorder = new PvRecorder(FRAME_LENGTH, config.device);
			recorder.start();
		} catch (error) {
			state = "idle";
			ctx.ui.setStatus(STATUS, undefined);
			ctx.ui.notify(`Voice input unavailable: ${(error as Error).message}`, "error");
			return;
		}
		if (hold && releasedWhilePreparing) {
			// The key was let go while the model was still loading: nothing worth transcribing.
			recorder.stop();
			recorder.release();
			recorder = undefined;
			state = "idle";
			ctx.ui.setStatus(STATUS, undefined);
			ctx.ui.notify("Voice input is ready. Hold the key while you speak.", "info");
			return;
		}

		state = "recording";
		frames = [];
		const started = Date.now();
		const hint = hold ? "release to stop" : config.autoStop ? "stops when you pause" : "press again to stop";
		const showTime = () =>
			ctx.ui.setStatus(STATUS, `● REC ${formatSeconds(Math.floor((Date.now() - started) / 1000))} · ${hint}`);
		showTime();
		ticker = setInterval(() => {
			showTime();
			if (Date.now() - started > config.maxSeconds * 1000) void stopRecording(ctx);
		}, 1000);

		const active = recorder;
		const autoStop = !hold && config.autoStop;
		recordingLoop = (async () => {
			let floor = Number.POSITIVE_INFINITY;
			let heard = false;
			let lastVoice = Date.now();
			while (state === "recording" && active.isRecording) {
				const frame = await active.read();
				frames.push(frame);
				if (!autoStop) continue;
				const level = rms(frame);
				// The quietest frame so far approximates background noise; speech is well above it.
				if (frames.length > 3) floor = Math.min(floor, level);
				if (level > Math.max(floor * 4, MIN_SPEECH_RMS)) {
					heard = true;
					lastVoice = Date.now();
				}
				const quietFor = Date.now() - lastVoice;
				if ((heard && quietFor > config.silenceMs) || (!heard && quietFor > NO_SPEECH_TIMEOUT_MS)) {
					// Stop outside this loop: stopRecording waits for the loop to finish.
					setImmediate(() => void stopRecording(ctx));
					return;
				}
			}
		})();
	}

	async function stopRecording(ctx: ExtensionContext): Promise<void> {
		if (state !== "recording") return;
		state = "transcribing";
		holding = false;
		clearInterval(ticker);
		await recordingLoop?.catch(() => undefined);
		recorder?.stop();
		recorder?.release();
		recorder = undefined;

		const samples = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
		let offset = 0;
		let peak = 0;
		for (const frame of frames) {
			samples.set(frame, offset);
			offset += frame.length;
			for (const s of frame) peak = Math.max(peak, Math.abs(s));
		}
		frames = [];

		if (samples.length < 16000 / 2 || peak < SILENCE_PEAK) {
			state = "idle";
			ctx.ui.setStatus(STATUS, undefined);
			ctx.ui.notify("Nothing heard. Check the microphone or speak a bit longer.", "warning");
			return;
		}

		ctx.ui.setStatus(STATUS, "voice: transcribing...");
		try {
			const worker = await ensureWhisper(ctx);
			const prompt = config.vocabulary.length ? config.vocabulary.join(", ") + "." : undefined;
			const text = await worker.transcribe(samples, config.language, prompt);
			if (text) {
				const current = ctx.ui.getEditorText();
				ctx.ui.pasteToEditor(current && !/\s$/.test(current) ? ` ${text}` : text);
			}
		} catch (error) {
			ctx.ui.notify(`Transcription failed: ${(error as Error).message}`, "error");
		} finally {
			state = "idle";
			ctx.ui.setStatus(STATUS, undefined);
		}
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (state === "idle") await startRecording(ctx, false);
		else if (state === "recording") await stopRecording(ctx);
	}

	// The shortcut is read from raw input rather than registerShortcut: hold-to-talk needs key
	// releases, which arrive only from terminals speaking the kitty keyboard protocol.
	function onKey(data: string, ctx: ExtensionContext) {
		if (matchesShortcut(data, config.stopSpeechShortcut)) {
			// Always handled here: the voice may be playing in another pi process.
			if (!isKeyRelease(data)) stopSpeakingEverywhere();
			return { consume: true };
		}
		if (!matchesShortcut(data, config.shortcut)) return undefined;
		if (!isKittyProtocolActive()) {
			void toggle(ctx);
		} else if (isKeyRelease(data)) {
			if (state === "preparing" && holding) releasedWhilePreparing = true;
			else if (state === "recording" && holding) void stopRecording(ctx);
		} else if (!isKeyRepeat(data)) {
			if (state === "idle") void startRecording(ctx, true);
			else if (state === "recording") void stopRecording(ctx);
		}
		return { consume: true };
	}

	pi.on("session_start", async (_event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => onKey(data, ctx));
		watchStopSignal();
	});

	pi.on("agent_start", async () => stopSpeaking());

	pi.on("agent_end", async (event) => {
		lastReply = lastReplyText(event.messages) ?? lastReply;
	});

	pi.on("agent_settled", async (event, ctx) => {
		// Re-read: /voice-tts may have been toggled in another pi process (e.g. the main one while
		// this is the pi-watcher side agent, which was started earlier and lives on).
		config.speak = loadConfig().speak;
		if (config.speak && !event.aborted && lastReply) void speakText(ctx, lastReply);
	});

	pi.registerCommand("voice-tts", {
		description: "Read finished replies aloud: on, off, or no argument to toggle",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg && arg !== "on" && arg !== "off") {
				ctx.ui.notify("Usage: /voice-tts on|off", "info");
				return;
			}
			config.speak = arg ? arg === "on" : !config.speak;
			saveSetting("speak", config.speak);
			if (!config.speak) stopSpeaking();
			ctx.ui.notify(
				config.speak ? `Replies will be read aloud. ${config.stopSpeechShortcut} stops reading.` : "Replies will not be read aloud.",
				"info",
			);
		},
	});

	pi.registerCommand("voice-say", {
		description: "Read the last reply aloud",
		handler: async (_args, ctx) => {
			if (!lastReply) {
				ctx.ui.notify("No reply to read yet.", "info");
				return;
			}
			await speakText(ctx, lastReply);
		},
	});

	pi.registerCommand("voice", {
		description: "Start/stop voice input (Russian/English, offline)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerCommand("voice-lang", {
		description: "Voice input language for this session: auto, ru or en",
		handler: async (args, ctx) => {
			const lang = args.trim() as Language;
			if (!["auto", "ru", "en"].includes(lang)) {
				ctx.ui.notify(`Language is ${config.language}. Usage: /voice-lang auto|ru|en`, "info");
				return;
			}
			config.language = lang;
			ctx.ui.notify(`Voice input language: ${lang}`, "info");
		},
	});

	pi.registerCommand("voice-devices", {
		description: "List microphones for the \"device\" setting in voice.json",
		handler: async (_args, ctx) => {
			const devices = PvRecorder.getAvailableDevices();
			ctx.ui.notify(devices.map((name, i) => `${i}: ${name}`).join("\n") || "No microphones found", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		clearInterval(ticker);
		state = "idle";
		await recordingLoop?.catch(() => undefined);
		recorder?.stop();
		recorder?.release();
		recorder = undefined;
		whisper?.stop();
		whisper = undefined;
		speaker?.dispose();
		speaker = undefined;
		stopWatcher?.close();
		stopWatcher = undefined;
	});
}
