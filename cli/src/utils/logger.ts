import chalk from 'chalk';
import pino from 'pino';
import pretty from 'pino-pretty';
import { BRAND_COLORS } from './colors';

/**
 * Create a configured pino logger instance
 */
// `flow push-dynamic --json` reserves stdout for the JSON plan, so every log
// line goes to stderr in that mode. The destination is fixed at construction,
// hence the argv check here.
const logToStderr =
  process.argv.includes('push-dynamic') && process.argv.includes('--json');

// Pretty-print in-process with synchronous writes instead of the pino-pretty
// worker-thread transport. The transport buffers lines in another thread, so a
// readline prompt written straight to stdout could appear ABOVE the plan it
// asks about, and lines still queued at exit were lost. Synchronous writes keep
// log lines, prompts and exit in program order.
export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pretty({
    colorize: false,
    translateTime: false,
    ignore: 'pid,hostname,context,level,time',
    messageFormat: '{msg}',
    singleLine: true,
    destination: logToStderr ? 2 : 1,
    sync: true,
  })
);

export { chalk };
export const warningColor = chalk.hex(BRAND_COLORS.orange);
export const bullet = '•';
export const checkMark = '✓';

export function heavyRule(length: number = 64): string {
  return '━'.repeat(length);
}

export function thinRule(length: number = 64): string {
  return '─'.repeat(length);
}

/**
 * Create a multicolored decorative line for headers
 */
export function createMulticoloredLine(length: number = 40): string {
  const colors = [
    chalk.hex(BRAND_COLORS.blue),
    chalk.hex(BRAND_COLORS.red),
    chalk.hex(BRAND_COLORS.yellow),
    chalk.hex(BRAND_COLORS.green),
  ];

  const segmentLength = Math.floor(length / colors.length);
  const segments = colors.map(color => color('━'.repeat(segmentLength)));
  return segments.join('');
}

/**
 * Create a colored header with multicolored line
 */
export function createHeader(label: string): string {
  const line = createMulticoloredLine(40);
  return `\n[${label}] ${line}`;
}

/**
 * Create a child logger with additional context
 */
export function createLogger(context: string) {
  return logger.child({ context });
}
