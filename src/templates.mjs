// Structured note templates. The AI fills the fields; BrainLink lays out the note the same
// way every time, turns people into [[links]] and action items into checkable tasks, and
// files it in the template's folder when the vault has one.

const list = (v) => (Array.isArray(v) ? v : v ? String(v).split('\n') : []).map((s) => String(s).trim()).filter(Boolean);
const link = (name) => (/^\[\[.*\]\]$/.test(name) ? name : `[[${name.replace(/[[\]|#]/g, '')}]]`);
const section = (h, body) => (body ? `## ${h}\n\n${body}\n\n` : '');
const bullets = (items) => list(items).map((x) => `- ${x}`).join('\n');
const tasks = (items) => list(items).map((x) => `- [ ] ${x.replace(/^\[ \]\s*/, '')}`).join('\n');

export const TEMPLATES = {
  meeting: {
    folder: 'Meetings', type: 'meeting',
    fields: { date: 'YYYY-MM-DD', attendees: 'names (become [[links]])', agenda: 'text', summary: 'text', decisions: 'list', action_items: 'list: "Owner — task — due"', transcript_source: 'where the transcript came from, if any' },
    render: (f) => `**Date:** ${f.date || ''}  \n**Attendees:** ${list(f.attendees).map(link).join(', ')}\n${f.transcript_source ? `**Source:** ${f.transcript_source}\n` : ''}\n`
      + section('Agenda', f.agenda) + section('Summary', f.summary) + section('Decisions', bullets(f.decisions)) + section('Action items', tasks(f.action_items)),
  },
  decision: {
    folder: 'Decisions', type: 'decision',
    fields: { context: 'text', options: 'list', decision: 'text', reasons: 'list', consequences: 'list', review_date: 'YYYY-MM-DD' },
    render: (f) => section('Context', f.context) + section('Options considered', bullets(f.options)) + section('Decision', f.decision ? `**${f.decision}**` : '')
      + section('Why', bullets(f.reasons)) + section('Consequences', bullets(f.consequences)) + (f.review_date ? section('Review', `- [ ] Review this decision on ${f.review_date}`) : ''),
  },
  person: {
    folder: 'People', type: 'person',
    fields: { role: 'text', organisation: 'name (becomes a [[link]])', how_we_met: 'text', last_contact: 'YYYY-MM-DD', notes: 'text', follow_ups: 'list' },
    render: (f) => `**Role:** ${f.role || ''}  \n**Organisation:** ${f.organisation ? link(f.organisation) : ''}  \n**Last contact:** ${f.last_contact || ''}\n\n`
      + section('How we met', f.how_we_met) + section('Notes', f.notes) + section('Follow-ups', tasks(f.follow_ups)),
  },
  project: {
    folder: 'Projects', type: 'project',
    fields: { goal: 'text', status: 'text', owner: 'name (becomes a [[link]])', milestones: 'list', risks: 'list', next_actions: 'list' },
    render: (f) => `**Status:** ${f.status || 'active'}  \n**Owner:** ${f.owner ? link(f.owner) : ''}\n\n`
      + section('Goal', f.goal) + section('Milestones', tasks(f.milestones)) + section('Risks', bullets(f.risks)) + section('Next actions', tasks(f.next_actions)),
  },
  idea: {
    folder: 'Ideas', type: 'idea',
    fields: { problem: 'text', idea: 'text', why_now: 'text', next_step: 'text' },
    render: (f) => section('Problem', f.problem) + section('Idea', f.idea) + section('Why now', f.why_now) + (f.next_step ? section('Next step', `- [ ] ${f.next_step}`) : ''),
  },
};

export function renderTemplate(name, fields = {}, extraBody = '') {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`Unknown template "${name}". Use one of: ${Object.keys(TEMPLATES).join(', ')}`);
  return (t.render(fields) + (extraBody ? `${String(extraBody).trim()}\n` : '')).trim();
}
