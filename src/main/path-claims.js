const path = require('path');

function normalizeClaim(value) {
  let claim = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!claim || path.posix.isAbsolute(claim) || claim === '..' || claim.startsWith('../') || claim.includes('/../')) throw new Error(`Invalid repository path claim: ${value}`);
  if (claim.endsWith('/')) claim += '**';
  return claim.slice(0, 4096);
}

function globRegex(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
      else { source += '.*'; i++; }
    }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function staticPrefix(claim) {
  const index = claim.search(/[?*]/);
  return (index < 0 ? claim : claim.slice(0, index)).replace(/\/$/, '');
}

function claimsOverlap(left, right) {
  const a = normalizeClaim(left); const b = normalizeClaim(right);
  if (a === b) return { overlap: true, severity: 'high' };
  if (globRegex(a).test(b) || globRegex(b).test(a)) return { overlap: true, severity: 'high' };
  const pa = staticPrefix(a); const pb = staticPrefix(b);
  if (pa && pb && (pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`))) return { overlap: true, severity: 'medium' };
  return { overlap: false, severity: 'none' };
}

function claimOverlaps(tasks) {
  const claims = [];
  for (const task of Object.values(tasks || {})) for (const claim of task.pathClaims || []) {
    try { claims.push({ taskId: task.id, path: normalizeClaim(claim.path) }); } catch {}
  }
  const overlaps = [];
  for (let i = 0; i < claims.length; i++) for (let j = i + 1; j < claims.length; j++) {
    const left = claims[i]; const right = claims[j];
    if (left.taskId === right.taskId) continue;
    const match = claimsOverlap(left.path, right.path);
    if (match.overlap) overlaps.push({ path: `${left.path} ↔ ${right.path}`, claims: [left.path, right.path], taskIds: [left.taskId, right.taskId], source: 'claim', severity: match.severity });
  }
  return overlaps;
}

module.exports = { normalizeClaim, claimsOverlap, claimOverlaps };
