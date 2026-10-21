const classes = (...arr) => arr.filter(v => v).join(' ');

const distance = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

const extension = fileName => /(?:\.([^.]+))?$/.exec(fileName)[1];

const refineGist = gist => {
  const gistId = gist.id;
  const title = gist.description;
  delete gist.files['algorithm-visualizer'];
  const { login, avatar_url } = gist.owner;
  const files = Object.values(gist.files).map(file => ({
    name: file.filename,
    content: file.content,
    contributors: [{ login, avatar_url }],
  }));
  return { login, gistId, title, files };
};

const createFile = (name, content, contributors) => ({ name, content, contributors });

const createProjectFile = (name, content) => createFile(name, content, [{
  login: 'algorithm-visualizer',
  avatar_url: 'https://github.com/algorithm-visualizer.png',
}]);

const createUserFile = (name, content) => createFile(name, content, undefined);

const isSaved = ({ titles, files, lastTitles, lastFiles }) => {
  const serialize = (titles, files) => JSON.stringify({
    titles,
    files: files.map(({ name, content }) => ({ name, content })),
  });
  return serialize(titles, files) === serialize(lastTitles, lastFiles);
};

// Identity of a code pad (one file of one page) for the AI assistant:
// each pad owns an AI session under this key, and deleting the file
// deletes the session with it.
const aiPadKey = (current, fileName) => {
  const page = current.scratchPaper ? `scratch:${current.scratchPaper.gistId}` :
    current.algorithm ? `${current.algorithm.categoryKey}/${current.algorithm.algorithmKey}` : 'home';
  return `${page}:${fileName}`;
};

const AI_SESSION_DELETE_EVENT = 'av-ai-session-delete';

// The AI Assistant hands a set of generated test cases to the
// Testcase panel of the same pad: detail = {key, entry, cases},
// where key is the pad key (aiPadKey) the cases belong to.
const TESTCASES_APPLY_EVENT = 'av-testcases-apply';

// The Testcase panel asks the Player to build and play a wrapped
// source (the pad's code plus a generated harness calling the entry
// with one case's args): detail = {code, name}. The visualization
// viewer also listens, to leave Markdown-doc mode for the playback.
const VISUALIZE_CASE_EVENT = 'av-visualize-case';

const notifyAiSessionDeleted = (current, fileName) => {
  window.dispatchEvent(new CustomEvent(AI_SESSION_DELETE_EVENT, { detail: aiPadKey(current, fileName) }));
};

export {
  classes,
  distance,
  extension,
  refineGist,
  createFile,
  createProjectFile,
  createUserFile,
  isSaved,
  aiPadKey,
  AI_SESSION_DELETE_EVENT,
  TESTCASES_APPLY_EVENT,
  VISUALIZE_CASE_EVENT,
  notifyAiSessionDeleted,
};
