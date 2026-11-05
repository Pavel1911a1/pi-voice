/**
 * Offline voice input for pi.
 *
 * Press the shortcut (default alt+m) or run /voice to start recording, press again to stop.
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
import type { KeyId } from "@earendil-works/pi-tui";
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
}

const DEFAULTS: VoiceConfig = {
	shortcut: "alt+m",
	language: "auto",
	vocabulary: [],
	model: "ggml-large-v3-turbo-q5_0.bin",
	device: -1,
	maxSeconds: 300,
};

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const STATUS = "voice";
const FRAME_LENGTH = 512;
// Below this peak amplitude the recording is treated as silence: whisper invents text for it.
const SILENCE_PEAK = 500;

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

function formatSeconds(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let state: "idle" | "preparing" | "recording" | "transcribing" = "idle";
	let whisper: WhisperContext | undefined;
	let recorder: PvRecorder | undefined;
	let frames: Int16Array[] = [];
	let recordingLoop: Promise<void> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

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

	async function startRecording(ctx: ExtensionContext): Promise<void> {
		state = "preparing";
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

		state = "recording";
		frames = [];
		const started = Date.now();
		const showTime = () => ctx.ui.setStatus(STATUS, `● REC ${formatSeconds(Math.floor((Date.now() - started) / 1000))}`);
		showTime();
		ticker = setInterval(() => {
			showTime();
			if (Date.now() - started > config.maxSeconds * 1000) void stopRecording(ctx);
		}, 1000);

		const active = recorder;
		recordingLoop = (async () => {
			while (state === "recording" && active.isRecording) frames.push(await active.read());
		})();
	}

	async function stopRecording(ctx: ExtensionContext): Promise<void> {
		if (state !== "recording") return;
		state = "transcribing";
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
		if (state === "idle") await startRecording(ctx);
		else if (state === "recording") await stopRecording(ctx);
	}

	pi.registerShortcut(config.shortcut as KeyId, {
		description: "Start/stop voice input",
		handler: toggle,
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
