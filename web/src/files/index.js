import { createProjectFile, createUserFile } from 'common/util';

const getName = filePath => filePath.split('/').pop();
const getContent = filePath => require('!raw-loader!./' + filePath).default;
const readProjectFile = filePath => createProjectFile(getName(filePath), getContent(filePath));
const readUserFile = filePath => createUserFile(getName(filePath), getContent(filePath));

export const CODE_CPP = readUserFile('skeletons/code.cpp');
export const CODE_JAVA = readUserFile('skeletons/code.java');
export const CODE_JS = readUserFile('skeletons/code.js');
export const CODE_PY = readUserFile('skeletons/code.py');
export const FEATURES_MD = readProjectFile('algorithm-visualizer/FEATURES.md');
export const LICENSE_FILE = readProjectFile('algorithm-visualizer/LICENSE');
export const SCRATCH_PAPER_README_MD = readProjectFile('scratch-paper/README.md');
