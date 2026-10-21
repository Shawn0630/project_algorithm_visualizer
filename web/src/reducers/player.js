import { combineActions, createAction, handleActions } from 'redux-actions';

const prefix = 'PLAYER';

const setChunks = createAction(`${prefix}/SET_CHUNKS`, chunks => ({ chunks }));
const setCursor = createAction(`${prefix}/SET_CURSOR`, cursor => ({ cursor }));
const setLineIndicator = createAction(`${prefix}/SET_LINE_INDICATOR`, lineIndicator => ({ lineIndicator }));
const setBuildError = createAction(`${prefix}/SET_BUILD_ERROR`, buildError => ({ buildError }));

export const actions = {
  setChunks,
  setCursor,
  setLineIndicator,
  setBuildError,
};

const defaultState = {
  chunks: [],
  cursor: 0,
  lineIndicator: undefined,
  buildError: null,
};

export default handleActions({
  [combineActions(
    setChunks,
    setCursor,
    setLineIndicator,
    setBuildError,
  )]: (state, { payload }) => ({
    ...state,
    ...payload,
  }),
}, defaultState);
