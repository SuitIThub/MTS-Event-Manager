import { WorkspaceIndex } from '../src/indexer';

/** The real workspace index over the game folder (MTS_WS_ROOT), for offline checks. */
export async function makeIndex(root = 'M:/MTS Project/Mind the School'): Promise<WorkspaceIndex> {
  process.env.MTS_WS_ROOT ??= root;
  const index = new WorkspaceIndex();
  await index.reindex();
  return index;
}
