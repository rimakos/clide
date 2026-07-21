function changedPathMap(taskStatuses) {
  const owners = new Map();
  for (const item of taskStatuses) {
    for (const file of item.files || []) {
      const list = owners.get(file.path) || [];
      list.push(item.taskId);
      owners.set(file.path, list);
    }
  }
  return [...owners.entries()]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([path, taskIds]) => ({ path, taskIds, severity: 'conflict-risk' }));
}

module.exports = { changedPathMap };
