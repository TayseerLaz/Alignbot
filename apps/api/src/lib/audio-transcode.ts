// Transcodes browser-recorded audio (audio/mp4, audio/webm, etc.) to
// audio/ogg with the Opus codec so Meta accepts it as a real WhatsApp
// voice note (play-in-place bubble with waveform). Without this Meta
// 200-OKs both /media and /messages but then drops the message with
// error 131053 because its delivery validator opens the file and
// rejects the container.
//
// Uses the bundled ffmpeg-static binary so we don't need ffmpeg on
// the host. Streams via stdin/stdout — the source clip is small (low
// tens of KB) so RAM pressure is negligible.
import { spawn } from 'node:child_process';

// ffmpeg-static is a CJS module that exports the path string as
// default. The ESM interop here matches what next/node typically does.
import ffmpegPath from 'ffmpeg-static';

export type TranscodeResult =
  | { ok: true; bytes: Buffer; mime: 'audio/ogg' }
  | { ok: false; error: string };

export async function transcodeToOggOpus(input: Buffer): Promise<TranscodeResult> {
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg binary not bundled at runtime' };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: TranscodeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // -i pipe:0       read input from stdin
    // -vn             drop any video stream the container may carry
    // -c:a libopus    Opus codec (Meta's requirement for audio/ogg)
    // -b:a 24k        modest bitrate — voice notes don't need more
    // -ac 1           mono — matches WhatsApp's native voice-note shape
    // -ar 16000       16 kHz sample rate — same
    // -f ogg          force OGG container regardless of input
    // pipe:1          write to stdout
    const args = [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ac', '1',
      '-ar', '16000',
      '-f', 'ogg',
      'pipe:1',
    ];

    let proc;
    try {
      proc = spawn(ffmpegPath as string, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return settle({ ok: false, error: err instanceof Error ? err.message : 'spawn failed' });
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    proc.on('error', (err) =>
      settle({ ok: false, error: err instanceof Error ? err.message : 'ffmpeg error' }),
    );
    proc.on('close', (code) => {
      if (code === 0 && outChunks.length > 0) {
        settle({ ok: true, bytes: Buffer.concat(outChunks), mime: 'audio/ogg' });
      } else {
        const err = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        settle({ ok: false, error: `ffmpeg exited ${code}: ${err || '(no stderr)'}` });
      }
    });

    // Hard cap so a hung ffmpeg never blocks a request.
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle({ ok: false, error: 'ffmpeg timeout (15s)' });
    }, 15_000);
    proc.on('close', () => clearTimeout(killTimer));

    // Push the input bytes and signal EOF.
    proc.stdin.on('error', (err) =>
      settle({ ok: false, error: err instanceof Error ? err.message : 'stdin error' }),
    );
    proc.stdin.end(input);
  });
}
