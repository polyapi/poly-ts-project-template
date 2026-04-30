/**
 * FLOW (PolyAPI CLI) ASCII Logo
 *
 * Renders the "FLOW" Slant Relief logo as colored ASCII art for CLI banners.
 * Each letter (F, L, O, W) is painted with a PolyAPI brand color by mapping
 * contiguous non-underscore clusters on each row to a letter index.
 */

import chalk from 'chalk';
import type { Logger } from 'pino';
import { BRAND_COLORS } from './colors';

// Ordered palette: F=blue, L=red, O=yellow, W=green
const BRAND_COLOR_SEQUENCE = [
  BRAND_COLORS.blue,
  BRAND_COLORS.red,
  BRAND_COLORS.yellow,
  BRAND_COLORS.green,
] as const;

// Slant Relief ASCII art for "FLOW"
const FLOW_LOGO = String.raw`
__/\\\\\\\\\\\\\\\__/\\\___________________/\\\\\_______/\\\______________/\\\_
 _\/\\\///////////__\/\\\_________________/\\\///\\\____\/\\\_____________\/\\\_
  _\/\\\_____________\/\\\_______________/\\\/__\///\\\__\/\\\_____________\/\\\_
   _\/\\\\\\\\\\\_____\/\\\______________/\\\______\//\\\_\//\\\____/\\\____/\\\__
    _\/\\\///////______\/\\\_____________\/\\\_______\/\\\__\//\\\__/\\\\\__/\\\___
     _\/\\\_____________\/\\\_____________\//\\\______/\\\____\//\\\/\\\/\\\/\\\____
      _\/\\\_____________\/\\\______________\///\\\__/\\\_______\//\\\\\\//\\\\\_____
       _\/\\\_____________\/\\\\\\\\\\\\\\\____\///\\\\\/_________\//\\\__\//\\\______
        _\///______________\///////////////_______\/////____________\///____\///_______`;

// Each row lists the letter index (0–3) for each contiguous non-underscore cluster.
// Clusters are found by splitting the line on runs of spaces and underscores.
const FLOW_LOGO_CLUSTER_COLOR_SEQUENCE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 3],
  [0, 1, 2, 3, 3],
  [0, 1, 2, 2, 3, 3],
  [0, 1, 2, 2, 3, 3, 3],
  [0, 1, 2, 2, 3, 3, 3],
  [0, 1, 2, 2, 3],
  [0, 1, 2, 2, 3],
  [0, 1, 2, 3, 3],
  [0, 1, 2, 3, 3],
];

function colorLogoLine(line: string, sequence: readonly number[]): string {
  // Split preserving underscore/space delimiters so we can reconstruct the line.
  const parts = line.split(/([ _]+)/);
  let clusterIdx = 0;
  return parts
    .map(part => {
      if (!part || /^[ _]+$/.test(part)) return part;
      const hex =
        BRAND_COLOR_SEQUENCE[sequence[clusterIdx] ?? 0] ?? BRAND_COLORS.blue;
      clusterIdx++;
      return chalk.hex(hex)(part);
    })
    .join('');
}

interface LogoOptions {
  useLogger?: boolean;
}

/**
 * Print the FLOW logo as colored ASCII art.
 * Works nicely in CLIs that already use chalk + pino.
 */
export function printFlowLogo(
  logger?: Logger | Console,
  opts: LogoOptions = {}
): void {
  const useLogger = opts.useLogger ?? Boolean(logger && 'info' in logger);

  // Strip leading/trailing newlines so line
  // indices align 1:1 with FLOW_LOGO_CLUSTER_COLOR_SEQUENCE.
  const logoLines = FLOW_LOGO.replace(/^\n+|\n+$/g, '').split('\n');
  const colored = logoLines.map((line, i) =>
    colorLogoLine(line, FLOW_LOGO_CLUSTER_COLOR_SEQUENCE[i] ?? [])
  );

  const logoWidth = Math.max(...logoLines.map(l => l.length));
  const segLen = Math.floor(logoWidth / 4);
  const rule = BRAND_COLOR_SEQUENCE.map((hex, i) =>
    chalk.hex(hex)('═'.repeat(i < 3 ? segLen : logoWidth - segLen * 3))
  ).join('');

  const finalOutput = `\n${rule}\n${colored.join('\n')}\n${rule}\n`;

  if (useLogger && logger && 'info' in logger) {
    logger.info(finalOutput);
  } else {
    process.stdout.write(finalOutput);
  }
}
