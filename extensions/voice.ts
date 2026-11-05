/**
 * Offline voice input for pi.
 *
 * Press the shortcut (default alt+m) or run /voice and speak: recording stops by itself when you
 * pause. In terminals that report key releases (Ghostty, kitty, WezTerm, iTerm2 with CSI u) hold
 * the shortcut while speaking and let go to stop.
 * Speech is transcribed locally with whisper.cpp and pasted into the editor; nothing leaves
 * the machine. The model is downloaded once on first use.
 *
 * Settings live in ~/.pi/agent/voice.json, see README.md.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initWhisper, type WhisperContext } from "@fugood/whisper.node";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { PvRecorder } from "@picovoice/pvrecorder-node";

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
};

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const STATUS = "voice";
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
		return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
	} catch {
		return { ...DEFAULTS };
	}
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

function rms(frame: Int16Array): number {
	let sum = 0;
	for (const s of frame) sum += s * s;
	return Math.sqrt(sum / frame.length);
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
	let whisper: WhisperContext | undefined;
	let recorder: PvRecorder | undefined;
	let frames: Int16Array[] = [];
	let recordingLoop: Promise<void> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;

	async function ensureWhisper(ctx: ExtensionContext): Promise<WhisperContext> {
		if (whisper) return whisper;
		if (!existsSync(modelPath(config))) {
			ctx.ui.notify(`Downloading speech model ${config.model} (one time, ~550 MB)...`, "info");
			await downloadModel(config, ctx);
		}
		ctx.ui.setStatus(STATUS, "voice: loading model");
		whisper = await initWhisper({ filePath: modelPath(config), useGpu: true });
		return whisper;
	}

	async function startRecording(ctx: ExtensionContext, hold: boolean): Promise<void> {
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
			const context = await ensureWhisper(ctx);
			const { promise } = context.transcribeData(samples.buffer, {
				language: config.language,
				prompt: config.vocabulary.length ? config.vocabulary.join(", ") + "." : undefined,
			});
			const text = (await promise).result.trim();
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
		if (!matchesKey(data, config.shortcut as KeyId)) return undefined;
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
		await whisper?.release();
		whisper = undefined;
	});
}
