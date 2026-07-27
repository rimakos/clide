const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClaim, claimsOverlap, claimOverlaps } = require('../src/main/path-claims');

test('path claims normalize repository-relative globs', () => {
  assert.equal(normalizeClaim('./src/features/'), 'src/features/**');
  assert.throws(() => normalizeClaim('../secret'), /invalid/i);
  assert.throws(() => normalizeClaim('/tmp/file'), /invalid/i);
});

test('path claims report exact and hotspot overlaps', () => {
  assert.deepEqual(claimsOverlap('src/**/*.js', 'src/app.js'), { overlap: true, severity: 'high' });
  assert.deepEqual(claimsOverlap('src/features/**', 'src/features/auth/**'), { overlap: true, severity: 'high' });
  assert.deepEqual(claimsOverlap('src/auth/*.js', 'src/auth/generated/*.ts'), { overlap: true, severity: 'medium' });
  const overlaps = claimOverlaps({
    a: { id: 'a', pathClaims: [{ path: 'src/**' }] },
    b: { id: 'b', pathClaims: [{ path: 'src/app.js' }] }
  });
  assert.equal(overlaps[0].severity, 'high');
});
