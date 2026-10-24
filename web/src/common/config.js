import { CODE_CPP, CODE_JAVA, CODE_JS, CODE_MD, CODE_PY } from 'files';

const languages = [{
  name: 'JavaScript',
  ext: 'js',
  mode: 'javascript',
  skeleton: CODE_JS,
}, {
  name: 'C++',
  ext: 'cpp',
  mode: 'c_cpp',
  skeleton: CODE_CPP,
}, {
  name: 'Java',
  ext: 'java',
  mode: 'java',
  skeleton: CODE_JAVA,
}, {
  name: 'Python',
  ext: 'py',
  mode: 'python',
  skeleton: CODE_PY,
}, {
  // Markdown notes are first-class pad files: they get a tab, an
  // editor (Ace markdown mode) and an AI session like code files,
  // and the doc pane previews the one being edited. They are not
  // runnable - the Player skips them.
  name: 'Markdown',
  ext: 'md',
  mode: 'markdown',
  skeleton: CODE_MD,
}];

const exts = languages.map(language => language.ext);

export {
  languages,
  exts,
};
