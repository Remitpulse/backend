import { describe, expect, it } from 'vitest'

import { isLocalAnchorDomain } from '../src/interfaces/anchors/toml'

describe('isLocalAnchorDomain', () => {
  it('treats loopback hostnames as local', () => {
    expect(isLocalAnchorDomain('localhost')).toBe(true)
    expect(isLocalAnchorDomain('localhost:4000')).toBe(true)
    expect(isLocalAnchorDomain('127.0.0.1')).toBe(true)
    expect(isLocalAnchorDomain('127.0.0.1:4000')).toBe(true)
    expect(isLocalAnchorDomain('::1')).toBe(true)
    expect(isLocalAnchorDomain('foo.localhost')).toBe(true)
  })

  it('treats real anchor domains as non-local, regardless of case', () => {
    expect(isLocalAnchorDomain('testanchor.stellar.org')).toBe(false)
    expect(isLocalAnchorDomain('TESTANCHOR.STELLAR.ORG')).toBe(false)
    expect(isLocalAnchorDomain('anchor.example.com:443')).toBe(false)
  })
})
