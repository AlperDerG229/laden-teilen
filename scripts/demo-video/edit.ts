// Video editing for scripts/record-demo.ts: cut the recorded webm files (one per page) by an edit
// list, join them into one 1280x720 30 fps H.264 MP4, check the result and pull still frames.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 30;
/** Acceptance window for the published video (WP4). */
export const MIN_SECONDS = 120;
export const MAX_SECONDS = 180;
export const MAX_BYTES = 50 * 1024 * 1024;

/** A piece of one recorded webm, in seconds from the start of that file. */
export interface Segment {
  label: string;
  file: string;
  start: number;
  end: number;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

function works(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * An ffmpeg with libx264 (Playwright's own ffmpeg only writes VP8): $FFMPEG_PATH, ~/.local/bin/ffmpeg
 * or ffmpeg on PATH, plus the ffprobe next to it.
 */
export function findTools(): Tools {
  const local = join(homedir(), '.local/bin');
  const candidates: Tools[] = [];
  if (process.env.FFMPEG_PATH) {
    candidates.push({ ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH ?? process.env.FFMPEG_PATH.replace(/ffmpeg$/, 'ffprobe') });
  }
  if (existsSync(join(local, 'ffmpeg'))) candidates.push({ ffmpeg: join(local, 'ffmpeg'), ffprobe: join(local, 'ffprobe') });
  candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  for (const c of candidates) {
    const encoders = works(c.ffmpeg, ['-hide_banner', '-encoders']);
    if (encoders?.includes('libx264') && works(c.ffprobe, ['-version'])) return c;
  }
  throw new Error(
    'No ffmpeg with libx264 found. Set FFMPEG_PATH (and FFPROBE_PATH), or put a static build at ~/.local/bin/ffmpeg ' +
      '(e.g. https://johnvansickle.com/ffmpeg/).',
  );
}

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')}`);
  return r.stdout;
}

const secs = (n: number): string => Math.max(0, n).toFixed(3);

/**
 * Cuts and joins `segments` into `out` in one ffmpeg pass: each piece is trimmed with input seeking
 * (frame-accurate when transcoding), normalised to 1280x720, 30 fps, yuv420p, and joined with hard
 * cuts or `fade` seconds of crossfade.
 */
export function encode(tools: Tools, segments: readonly Segment[], out: string, opts: { crf: number; fade: number }): void {
  if (segments.length === 0) throw new Error('Nothing to encode');
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const s of segments) args.push('-ss', secs(s.start), '-t', secs(s.end - s.start), '-i', s.file);
  const norm = `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB`;
  const graph = segments.map((_s, i) => `[${i}:v]${norm}[v${i}]`);
  if (segments.length === 1) {
    graph.push('[v0]null[out]');
  } else if (opts.fade > 0) {
    // xfade offsets are positions in the growing output: sum of the earlier pieces minus the overlaps.
    let prev = 'v0';
    let offset = 0;
    segments.slice(1).forEach((_s, k) => {
      offset += segments[k].end - segments[k].start - opts.fade;
      const next = k === segments.length - 2 ? 'out' : `x${k + 1}`;
      graph.push(`[${prev}][v${k + 1}]xfade=transition=fade:duration=${opts.fade}:offset=${offset.toFixed(3)}[${next}]`);
      prev = next;
    });
  } else {
    graph.push(`${segments.map((_s, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[out]`);
  }
  args.push('-filter_complex', graph.join(';'), '-map', '[out]');
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf), '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-g', String(FPS * 2), '-movflags', '+faststart', '-an', out);
  run(tools.ffmpeg, args);
}

export interface Probe {
  codec: string;
  width: number;
  height: number;
  fps: string;
  seconds: number;
  bytes: number;
}

export function probe(tools: Tools, file: string): Probe {
  const json = JSON.parse(
    run(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', file]),
  ) as { streams: { codec_name: string; width: number; height: number; avg_frame_rate: string }[]; format: { duration: string } };
  const v = json.streams[0];
  return { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate, seconds: Number(json.format.duration), bytes: statSync(file).size };
}

/** Problems with the finished video; empty when it meets the WP4 acceptance criteria. */
export function gate(p: Probe): string[] {
  const problems: string[] = [];
  if (p.codec !== 'h264') problems.push(`codec ${p.codec}, expected h264`);
  if (p.width !== WIDTH || p.height !== HEIGHT) problems.push(`size ${p.width}x${p.height}, expected ${WIDTH}x${HEIGHT}`);
  if (p.seconds < MIN_SECONDS || p.seconds > MAX_SECONDS) problems.push(`duration ${p.seconds.toFixed(1)} s, expected ${MIN_SECONDS}-${MAX_SECONDS} s`);
  if (p.bytes >= MAX_BYTES) problems.push(`size ${(p.bytes / 1e6).toFixed(1)} MB, expected under 50 MB`);
  return problems;
}

/** Extracts one PNG per `at` (seconds into `file`) into `dir`; returns the paths. */
export function stills(tools: Tools, file: string, shots: readonly { name: string; at: number }[], dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return shots.map((s, i) => {
    const path = join(dir, `${String(i + 1).padStart(2, '0')}-${s.name}.png`);
    run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', secs(s.at), '-i', file, '-frames:v', '1', path]);
    return path;
  });
}

export const formatClock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${String(Math.floor((seconds % 1) * 10))}`;
