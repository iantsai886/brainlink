// BrainLink store error types (contract v0.1). Every error has a stable `code`; MCP returns err.toJSON().
export class StoreError extends Error {
  static code = 'E_STORE';
  constructor(message = '', detail = {}) { super(message || new.target.code); this.name = new.target.name; this.code = new.target.code; this.detail = detail; }
  toJSON() { return { error: this.code, message: this.message, ...this.detail }; }
}
export class NotFound extends StoreError { static code = 'E_NOT_FOUND'; }        // unknown id / path / version / blob
export class Conflict extends StoreError { static code = 'E_CONFLICT'; }         // CAS failed; detail.current_etag
export class Invalid extends StoreError { static code = 'E_INVALID'; }           // bad path / id / frontmatter / args
export class PrivacyDenied extends StoreError { static code = 'E_PRIVACY'; }     // scope not allowed for this caller
export class Superseded extends StoreError { static code = 'E_SUPERSEDED'; }     // write to superseded note; detail.superseded_by
export class ReadOnly extends StoreError { static code = 'E_READ_ONLY'; }        // store opened read-only
export class SnapshotNotFound extends StoreError { static code = 'E_SNAPSHOT'; } // unknown snapshot id
export class CursorExpired extends StoreError { static code = 'E_CURSOR'; }      // cursor older than retained log -> full resync
export const ERROR_CODES = Object.freeze([StoreError, NotFound, Conflict, Invalid, PrivacyDenied, Superseded, ReadOnly, SnapshotNotFound, CursorExpired].map((c) => c.code));
