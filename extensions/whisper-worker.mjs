// Runs whisper.cpp in a child process: its native logging writes straight to stderr, which would
// draw over pi's screen, and the binding's own log switch hangs. The parent starts this process
// with stdio ignored and talks to it over IPC.

import { initWhisper } from "@fugood/whisper.node";

let context;

process.on("message", async (message) => {
	try {
		if (message.type === "init") {
			context = await initWhisper({ filePath: message.model, useGpu: true });
			process.send({ type: "ready" });
		} else if (message.type === "transcribe") {
			const pcm = message.pcm;
			const { promise } = context.transcribeData(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), {
				language: message.language,
				prompt: message.prompt,
			});
			process.send({ type: "result", id: message.id, text: (await promise).result.trim() });
		}
	} catch (error) {
		process.send({ type: "error", id: message.id, message: String(error?.message ?? error) });
	}
});

process.on("disconnect", async () => {
	await context?.release();
	process.exit(0);
});
