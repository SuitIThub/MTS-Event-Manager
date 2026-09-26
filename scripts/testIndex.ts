import { WorkspaceIndex } from '../src/indexer';
import { WS_ROOT } from './testEnv';

/** The real workspace index over the game folder (MTS_WS_ROOT), for offline checks. */
export async function makeIndex(root = WS_ROOT): Promise<WorkspaceIndex> {
  process.env.MTS_WS_ROOT ??= root;
  const index = new WorkspaceIndex();
  await index.reindex();
  return index;
}
