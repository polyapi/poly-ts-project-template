import chalk from 'chalk';
import pino from 'pino';
import { BRAND_COLORS } from './colors';

/**
 * Create a configured pino logger instance
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      translateTime: false,
      ignore: 'pid,hostname,context,level,time',
      messageFormat: '{msg}',
      singleLine: true,
    },
  },
});

export { chalk };
export const warningColor = chalk.hex(BRAND_COLORS.orange);

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
