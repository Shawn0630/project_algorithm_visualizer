import { combineActions, createAction, handleActions } from 'redux-actions';
import { FEATURES_MD, LICENSE_MD } from 'files';
import { extension, isSaved } from 'common/util';
import { overlaySavedCode, persistCode, dropSavedCode, moveSavedCode, resetSavedCode, noteUserFile, forgetUserFile } from 'common/savedCode';

const prefix = 'CURRENT';

const setHome = createAction(`${prefix}/SET_HOME`, () => defaultState);
const setAlgorithm = createAction(`${prefix}/SET_ALGORITHM`, ({ categoryKey, categoryName, algorithmKey, algorithmName, files, description }) => ({
  algorithm: { categoryKey, algorithmKey },
  titles: [categoryName, algorithmName],
  files,
  description,
}));
const setScratchPaper = createAction(`${prefix}/SET_SCRATCH_PAPER`, ({ login, gistId, title, files }) => ({
  scratchPaper: { login, gistId },
  titles: ['Scratch Paper', title],
  files,
  description: homeDescription,
}));
const setLicense = createAction(`${prefix}/SET_LICENSE`, () => ({
  algorithm: { categoryKey: 'algorithm-visualizer', algorithmKey: 'license' },
  scratchPaper: undefined,
  titles: ['License'],
  files: [LICENSE_MD],
  description: homeDescription,
}));
const setEditingFile = createAction(`${prefix}/SET_EDITING_FILE`, file => ({ file }));
const modifyTitle = createAction(`${prefix}/MODIFY_TITLE`, title => ({ title }));
const addFile = createAction(`${prefix}/ADD_FILE`, file => ({ file }));
const renameFile = createAction(`${prefix}/RENAME_FILE`, (file, name) => ({ file, name }));
const modifyFile = createAction(`${prefix}/MODIFY_FILE`, (file, content) => ({ file, content }));
const replaceFile = createAction(`${prefix}/REPLACE_FILE`, (file, name, content) => ({ file, name, content }));
const deleteFile = createAction(`${prefix}/DELETE_FILE`, file => ({ file }));

export const actions = {
  setHome,
  setAlgorithm,
  setScratchPaper,
  setLicense,
  setEditingFile,
  modifyTitle,
  addFile,
  modifyFile,
  replaceFile,
  deleteFile,
  renameFile,
};

const homeTitles = ['Algorithm Visualizer'];
const homeFiles = [FEATURES_MD, LICENSE_MD];
const homeDescription = 'Algorithm Visualizer is an interactive online platform that visualizes algorithms from code.';
const defaultState = {
  algorithm: {
    categoryKey: 'algorithm-visualizer',
    algorithmKey: 'home',
  },
  scratchPaper: undefined,
  titles: homeTitles,
  files: homeFiles,
  lastTitles: homeTitles,
  lastFiles: homeFiles,
  description: homeDescription,
  editingFile: undefined,
  shouldBuild: true,
  saved: true,
};

export default handleActions({
  [combineActions(
    setHome,
    setAlgorithm,
    setScratchPaper,
    setLicense,
  )]: (state, { payload }) => {
    const { algorithm, scratchPaper, titles, description } = payload;
    // The user's local copy of a pad (if any) wins over the shipped
    // content; both files and lastFiles use the overlaid array, so a
    // restored copy does not read as "unsaved".
    const files = overlaySavedCode({ algorithm, scratchPaper }, payload.files);
    return {
      ...state,
      algorithm,
      scratchPaper,
      titles,
      files,
      lastTitles: titles,
      lastFiles: files,
      description,
      editingFile: undefined,
      shouldBuild: true,
      saved: true,
    };
  },
  [setEditingFile]: (state, { payload }) => {
    const { file } = payload;
    return {
      ...state,
      editingFile: file,
      shouldBuild: true,
    };
  },
  [modifyTitle]: (state, { payload }) => {
    const { title } = payload;
    const newState = {
      ...state,
      titles: [state.titles[0], title],
    };
    return {
      ...newState,
      saved: isSaved(newState),
    };
  },
  [addFile]: (state, { payload }) => {
    const { file } = payload;
    // A user-added file must survive reloads: register it on the
    // page's user-file list and keep its skeleton as its code
    // copy, so the load path can re-create it.
    noteUserFile(state, file.name);
    persistCode(state, file.name, file.content);
    const newState = {
      ...state,
      files: [...state.files, file],
      editingFile: file,
      // A new code file builds so its skeleton run shows; a new
      // Markdown note does not build into the player at all (the
      // doc pane previews it instead).
      shouldBuild: extension(file.name) !== 'md',
    };
    return {
      ...newState,
      saved: isSaved(newState),
    };
  },
  [combineActions(
    renameFile,
    modifyFile,
    replaceFile,
  )]: (state, { payload }) => {
    const { file, ...update } = payload;
    const editingFile = { ...file, ...update };
    // Keep the pad's local code copy in step with the edit.
    if (update.name !== undefined && update.content !== undefined) {
      // replaceFile (language template): fresh start for the pad.
      resetSavedCode(state, file.name, update.name, update.content);
    } else if (update.name !== undefined) {
      moveSavedCode(state, file.name, update.name);
    } else if (update.content !== undefined) {
      persistCode(state, file.name, update.content);
    }
    const newState = {
      ...state,
      files: state.files.map(oldFile => oldFile === file ? editingFile : oldFile),
      editingFile,
      // Edits never auto-build: code rebuilds on file switch or
      // the Build button, and Markdown is previewed by the doc
      // pane, not the player.
      shouldBuild: false,
    };
    return {
      ...newState,
      saved: isSaved(newState),
    };
  },
  [deleteFile]: (state, { payload }) => {
    const { file } = payload;
    dropSavedCode(state, file.name);
    forgetUserFile(state, file.name);
    const index = state.files.indexOf(file);
    const files = state.files.filter(oldFile => oldFile !== file);
    const editingFile = files[Math.min(index, files.length - 1)];
    const newState = {
      ...state,
      files,
      editingFile,
      shouldBuild: true,
    };
    return {
      ...newState,
      saved: isSaved(newState),
    };
  },
}, defaultState);
