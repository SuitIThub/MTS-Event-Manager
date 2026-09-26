import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the tests find the game: MTS_WS_ROOT = the folder that contains `game/`
 * (a Mind the School checkout). Without it the game-dependent checks are skipped, so the
 * suite also runs in CI and on machines without the game.
 */
export const WS_ROOT = (process.env.MTS_WS_ROOT || 'M:/MTS Project/Mind the School').replace(/\\/g, '/');
export const GAME = `${WS_ROOT}/game`;
export const SCRIPTS = `${GAME}/scripts`;

/**
 * Stop this check (successfully) when the game is not available.
 * - 'scripts': needs the .rpy files (fuzzers run over whatever version is checked out).
 * - 'full': needs the complete local game incl. images — the fixture checks assert
 *   concrete events and files of the maintainer's game version.
 */
export function requireGame(check: string, need: 'scripts' | 'full'): void {
  const ok = fs.existsSync(SCRIPTS) && (need === 'scripts' || (fs.existsSync(`${GAME}/images`) && process.env.MTS_SKIP_FIXTURES !== '1'));
  if (!ok) {
    console.log(`${check}: skipped — ${need === 'full' ? 'full game with images' : 'game scripts'} not found at ${WS_ROOT} (set MTS_WS_ROOT)`);
    process.exit(0);
  }
  process.env.MTS_WS_ROOT = WS_ROOT;
}

export const gamePath = (...parts: string[]) => path.join(GAME, ...parts);
