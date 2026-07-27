function cleanList(values, maxItems = 100, maxLength = 1000) {
  return Array.isArray(values) ? values.map(value => String(value || '').trim().slice(0, maxLength)).filter(Boolean).slice(-maxItems) : [];
}

function normalizeWorkspaceContext(input = {}) {
  return {
    summary: String(input.summary || '').trim().slice(0, 8000),
    constraints: cleanList(input.constraints, 100, 1000),
    commands: cleanList(input.commands, 50, 1000),
    conventions: cleanList(input.conventions, 100, 1000),
    decisions: Array.isArray(input.decisions) ? input.decisions.map(item => ({
      id: String(item.id || '').slice(0, 120), title: String(item.title || '').trim().slice(0, 200),
      body: String(item.body || '').trim().slice(0, 4000), at: String(item.at || '').slice(0, 40),
      by: String(item.by || '').slice(0, 160)
    })).filter(item => item.title || item.body).slice(-200) : [],
    updatedAt: String(input.updatedAt || '').slice(0, 40), updatedBy: String(input.updatedBy || '').slice(0, 160)
  };
}

function workerContextPrompt(context) {
  const value = normalizeWorkspaceContext(context); const sections = [];
  if (value.summary) sections.push(`Repository brief:\n${value.summary}`);
  if (value.constraints.length) sections.push(`Constraints:\n${value.constraints.map(item => `- ${item}`).join('\n')}`);
  if (value.commands.length) sections.push(`Useful commands:\n${value.commands.map(item => `- ${item}`).join('\n')}`);
  if (value.conventions.length) sections.push(`Conventions:\n${value.conventions.map(item => `- ${item}`).join('\n')}`);
  if (value.decisions.length) sections.push(`Recent decisions:\n${value.decisions.slice(-10).map(item => `- ${item.title}: ${item.body}`).join('\n')}`);
  return sections.join('\n\n').slice(0, 12000);
}

module.exports = { normalizeWorkspaceContext, workerContextPrompt };
