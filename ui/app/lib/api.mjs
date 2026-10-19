// The only door from UI to data.
/** @typedef {import('../../../../brainlink-store/interface.d.ts').BrainStore} BrainStore */
/** @typedef {import('../../../../brainlink-store/interface.d.ts').Access} Access */
/**
 * services (outside the store contract; provided by the app shell / setup server):
 *  connectors.detect(): Promise<App[]>   App = {id,name,installed,connected,transport:'stdio'|'http'|'tunnel',config_path,last_test?:TestResult|null}
 *  connectors.connect(id): Promise<App>  writes the client's MCP config with a timestamped backup (src/connectors.mjs connectClient)
 *  connectors.test(id): Promise<TestResult>  TestResult = {ok,latency_ms,tool_count,error?}  live MCP initialize + tools/list
 *  connectors.disconnect(id): Promise<App>  restores the backup (disconnectClient)
 *  search?.query(q, {vaults,folder,tags,type,from,to,limit}): Promise<{verdict:'hits'|'weak'|'not_in_brain',hits:Hit[],tokens_est}>
 *     Hit = {id,vault,path,title,heading,snippet,score}. Absent => storeSearch() fallback.
 *  sessions?.setPrivate(id, bool)  NOT in contract v0.1 (privacy = vault.private). Absent => toggle disabled.
 * @param {{store: BrainStore, services: object, access?: Access}} o
 */
export function createApi({ store, services = {}, access = {} }) {
  if (!store) throw new Error('createApi needs a BrainStore');
  return { store, services, access, vaults: () => store.vaults() };
}
