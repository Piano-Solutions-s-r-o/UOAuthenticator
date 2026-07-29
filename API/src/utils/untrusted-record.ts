// Safe lookups into records that came from a JWT payload.
//
// `JSON.parse` produces objects whose prototype is `Object.prototype`, so a
// plain `record[key]` lookup silently resolves inherited members: for
// `key = "constructor"` it returns the `Object` constructor (truthy), and for
// `"toString"` / `"valueOf"` / `"hasOwnProperty"` it returns a function. A
// presence check written as `!record[key]` therefore passes *vacuously* for
// those keys even though the token never carried them — the check reads as a
// constraint but enforces nothing.
//
// Every consistency check over an attacker-influenced claim map (e.g. a token's
// `org.team_roles`) must go through these helpers rather than bare indexing.

/** True only when `key` is an own member of `record`, never an inherited one. */
export function hasOwnKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
