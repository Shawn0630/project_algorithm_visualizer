// Line-based diff between the file the AI was given and the code it
// proposed, grouped into hunks the user can accept or drop one by one.
// Accepting applies the chosen hunks onto the CURRENT editor content
// (not a wholesale replace): each hunk is anchored on its changed
// core only - the surrounding context lines are display-only - so
// hand edits elsewhere (even inside the displayed context) survive,
// and a hunk whose changed lines were themselves edited reports as
// failed instead of patching the wrong place.

const CONTEXT = 2;

function diffOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths table (files here are small; a full table is fine).
  const dp = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({type: 'same', line: oldLines[i], oldIndex: i});
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: 'del', line: oldLines[i], oldIndex: i});
      i++;
    } else {
      ops.push({type: 'add', line: newLines[j], oldIndex: -1});
      j++;
    }
  }
  while (i < n) {
    ops.push({type: 'del', line: oldLines[i], oldIndex: i});
    i++;
  }
  while (j < m) {
    ops.push({type: 'add', line: newLines[j], oldIndex: -1});
    j++;
  }
  return ops;
}

// Returns hunks: [{id, lines, coreOld, coreNew, coreStart}]. `lines`
// includes context for display; `coreOld`/`coreNew` are the changed
// block (first to last change, internal unchanged lines included)
// used for locating and patching; `coreStart` is the core's line
// index in the original text, a positioning hint for the apply step.
export function computeHunks(oldText, newText) {
  const ops = diffOps(oldText.split('\n'), newText.split('\n'));
  const changeIndexes = [];
  ops.forEach((op, index) => {
    if (op.type !== 'same') changeIndexes.push(index);
  });
  if (!changeIndexes.length) return [];
  const groups = [];
  let start = changeIndexes[0];
  let prev = changeIndexes[0];
  for (let k = 1; k < changeIndexes.length; k++) {
    const index = changeIndexes[k];
    if (index - prev - 1 > CONTEXT * 2) {
      groups.push([start, prev]);
      start = index;
    }
    prev = index;
  }
  groups.push([start, prev]);
  return groups.map(([s, e], id) => {
    const lines = ops.slice(Math.max(0, s - CONTEXT), Math.min(ops.length, e + CONTEXT + 1));
    const core = ops.slice(s, e + 1);
    return {
      id,
      lines,
      coreOld: core.filter(l => l.type !== 'add').map(l => l.line),
      coreNew: core.filter(l => l.type !== 'del').map(l => l.line),
      coreStart: core[0].oldIndex >= 0 ? core[0].oldIndex : (ops[s - 1] ? ops[s - 1].oldIndex + 1 : 0),
    };
  });
}

function findCore(lines, coreOld, hint, cursor) {
  if (coreOld.length === 0) {
    return Math.max(cursor, Math.min(hint, lines.length));
  }
  const matchesAt = s => {
    for (let k = 0; k < coreOld.length; k++) {
      if (lines[s + k] !== coreOld[k]) return false;
    }
    return true;
  };
  if (hint >= cursor && hint + coreOld.length <= lines.length && matchesAt(hint)) return hint;
  for (let s = cursor; s + coreOld.length <= lines.length; s++) {
    if (matchesAt(s)) return s;
  }
  return -1;
}

// Applies the given hunks to currentText. Returns the patched text,
// how many hunks applied, and the ids that could not be located.
export function applyHunks(currentText, hunks) {
  let lines = currentText.split('\n');
  let cursor = 0;
  let applied = 0;
  const failed = [];
  hunks.forEach(hunk => {
    const found = findCore(lines, hunk.coreOld, hunk.coreStart, cursor);
    if (found === -1) {
      failed.push(hunk.id);
      return;
    }
    lines = [...lines.slice(0, found), ...hunk.coreNew, ...lines.slice(found + hunk.coreOld.length)];
    cursor = found + hunk.coreNew.length;
    applied++;
  });
  return {text: lines.join('\n'), applied, failed};
}
